// WeakenBench harness — the benchmark side of the verification-strength
// differential. Reads the raw corpus `harvest.ts` writes (kept OUTSIDE this
// public repo: it holds private product test code), builds the labelling pool,
// samples the pilot, prints diffs for hand-labelling, runs the classifier, and
// scores predictions against labels. Only ids and metadata ever leave the
// corpus directory; pair content is printed to the terminal, never written.
//
//   npx tsx tools/weakenbench/bench.ts pool     --corpus raw.jsonl --out <dir>
//   npx tsx tools/weakenbench/bench.ts sample   --pool <dir>/pool.jsonl --framework playwright --n 60 --seed 20260904 --out <dir>/pilot.ids
//   npx tsx tools/weakenbench/bench.ts show     --corpus raw.jsonl --ids a,b,c [--context 1] [--max 90]
//   npx tsx tools/weakenbench/bench.ts surface  --corpus raw.jsonl --ids <file>
//   npx tsx tools/weakenbench/bench.ts classify --corpus raw.jsonl --ids <file> --out predictions.jsonl
//   npx tsx tools/weakenbench/bench.ts freeze   --ids <file> --sources <paths,...> --out <dir>/holdout.freeze.json
//   npx tsx tools/weakenbench/bench.ts score    --labels labels.jsonl --predictions predictions.jsonl --pool pool.jsonl [--ids <file>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTestPredicatesFromSource, type ExtractPredicatesResult } from '../../apps/web-server/src/shared/ast-extractor'
import { diffSpecPredicates } from '../../apps/web-server/src/shared/verification-strength/differential'
import { strengthOf } from '../../apps/web-server/src/shared/verification-strength/lattice'
import type { SpecDiff, StrengthVerdict } from '../../shared/verification-strength/types'
import type { RawPair } from './harvest'

export type PoolFramework = 'playwright' | 'vitest'

/** One pool row: everything the hub may hold about a pair — no content. */
export interface PoolEntry {
  id: string
  framework: PoolFramework
  source: RawPair['source']
  granularity: RawPair['granularity']
  publicOk: boolean
  file: string
  changedLines: number
  /** Did the multiset of `expect` lines change? Cheap stratification signal, not a verdict. */
  assertionChanged: boolean
}

export interface Label {
  id: string
  label: 'weaker' | 'equivalent' | 'stronger' | 'changed' | 'excluded'
  tags?: string[]
  why?: string
  labeller?: string
  labelledAt?: string
}

export interface Prediction {
  id: string
  verdict: StrengthVerdict
  /** Per-test rows flattened to `kind:verdict[:reason]`, plus file-level reasons. */
  detail: string[]
  wrapped: { before: boolean; after: boolean }
}

const PLAYWRIGHT_IMPORT = /^\s*import\b[^\n]*from\s+['"]@playwright\/test['"]/m
const PLAYWRIGHT_MARKER = /\b(page\.|locator\(|getBy(Role|Text|TestId|Label|Placeholder)\(|toBeVisible|toHaveText|toHaveURL|toHaveCount)/
const UNIT_TEST_FILE = /\.test\.(ts|tsx|js|mjs|cjs)$/
const SPEC_FILE = /\.spec\.(ts|tsx|js|mjs|cjs)$/
const EXPECT_LINE = /^.*\bexpect\b.*$/gm

/** Which benchmark pool a raw pair belongs to, or none.
 *  - canary-lab's own vitest files *mention* Playwright in fixture strings, so a
 *    `.test.` file is never Playwright whatever its content says.
 *  - NestJS names jest suites `*.spec.ts`; a spec file counts as Playwright only
 *    with the import, the harvester's tag, or Playwright markers under `e2e/`. */
export function poolFramework(pair: RawPair): PoolFramework | undefined {
  const base = path.basename(pair.filePath)
  if (UNIT_TEST_FILE.test(base)) return pair.framework === 'vitest' ? 'vitest' : undefined
  if (PLAYWRIGHT_IMPORT.test(pair.before) || PLAYWRIGHT_IMPORT.test(pair.after)) return 'playwright'
  if (pair.framework === 'playwright' && SPEC_FILE.test(base)) return 'playwright'
  const marked = PLAYWRIGHT_MARKER.test(pair.before) || PLAYWRIGHT_MARKER.test(pair.after)
  if (pair.framework === 'unknown' && pair.granularity === 'fragment' && marked && pair.filePath.includes('/e2e/')) return 'playwright'
  return undefined
}

function expectLines(source: string): string {
  return (source.match(EXPECT_LINE) ?? []).map((line) => line.trim()).sort().join('\n')
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T)
}

function readIds(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

function corpusById(file: string, ids?: Set<string>): Map<string, RawPair> {
  const map = new Map<string, RawPair>()
  for (const pair of readJsonl<RawPair>(file)) if (!ids || ids.has(pair.id)) map.set(pair.id, pair)
  return map
}

// Deterministic PRNG so a sample is reproducible from its seed alone.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function unifiedDiff(before: string, after: string, context: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weakenbench-'))
  try {
    const a = path.join(dir, 'before')
    const b = path.join(dir, 'after')
    fs.writeFileSync(a, before)
    fs.writeFileSync(b, after)
    const result = spawnSync('git', ['diff', '--no-index', '--no-color', `--unified=${context}`, '--', a, b], { encoding: 'utf8' })
    return result.stdout
      .split('\n')
      .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line))
      .join('\n')
      .trim()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A pair is parsed under its own file name: the extension picks the script kind, and
// a `.test.tsx` side full of JSX mocks mis-parses as plain TypeScript.
function sideFile(pair: RawPair): string {
  return path.basename(pair.filePath) || 'pair.spec.ts'
}

// A fragment (an Edit tool's old/new string) often has no `test(` wrapper. Parse
// it as-is first; when nothing declares a test, wrap it so its assertions still
// form a predicate set. `wrapped` is reported so a reader knows which path ran.
function extractSide(source: string, file: string, wrap = false): { result: ExtractPredicatesResult; wrapped: boolean } {
  const direct = wrap ? undefined : extractTestPredicatesFromSource(file, source)
  if (direct && (direct.parseError || direct.tests.length)) return { result: direct, wrapped: false }
  return { result: extractTestPredicatesFromSource(file, `test('fragment', async () => {\n${source}\n})`), wrapped: true }
}

export function classifyPair(pair: RawPair): Prediction {
  const file = sideFile(pair)
  let before = extractSide(pair.before, file)
  let after = extractSide(pair.after, file)
  // A fragment whose edit adds the first `test(` wrapper — or removes the last — has
  // one side declaring tests and the other bare assertions. Diffing a synthetic
  // wrapper test against real ones reads as the wrapper being deleted; the honest
  // comparison is the two assertion sets as one fragment, so both sides wrap.
  if (before.wrapped !== after.wrapped) {
    before = extractSide(pair.before, file, true)
    after = extractSide(pair.after, file, true)
  }
  const diff: SpecDiff = diffSpecPredicates(before.result, after.result)
  const detail = [
    ...(diff.reasons ?? []).map((reason) => `file:${reason}`),
    ...diff.tests.flatMap((test) => [
      `${test.kind}:${test.verdict}:${test.name}`,
      ...test.changes.map((change) => `  ${change.kind}:${change.verdict}${change.reason ? `:${change.reason}` : ''}`),
    ]),
  ]
  return { id: pair.id, verdict: diff.verdict, detail, wrapped: { before: before.wrapped, after: after.wrapped } }
}

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

function need(argv: string[], name: string): string {
  const value = arg(argv, name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function cmdPool(argv: string[]): void {
  const outDir = need(argv, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const entries: PoolEntry[] = []
  const dropped = new Map<string, number>()
  for (const pair of readJsonl<RawPair>(need(argv, 'corpus'))) {
    const framework = poolFramework(pair)
    if (!framework) {
      const key = `${pair.framework}/${path.extname(path.basename(pair.filePath, path.extname(pair.filePath)))}`
      dropped.set(key, (dropped.get(key) ?? 0) + 1)
      continue
    }
    const changedLines = unifiedDiff(pair.before, pair.after, 0).split('\n').filter((line) => /^[+-]/.test(line)).length
    entries.push({
      id: pair.id,
      framework,
      source: pair.source,
      granularity: pair.granularity,
      publicOk: pair.publicOk,
      file: path.basename(pair.filePath),
      changedLines,
      assertionChanged: expectLines(pair.before) !== expectLines(pair.after),
    })
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  fs.writeFileSync(path.join(outDir, 'pool.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const byFramework = new Map<string, number>()
  for (const entry of entries) byFramework.set(entry.framework, (byFramework.get(entry.framework) ?? 0) + 1)
  console.log(`pool: ${entries.length} pairs`, Object.fromEntries(byFramework))
  console.log('dropped:', Object.fromEntries(dropped))
}

function cmdSample(argv: string[]): void {
  const framework = need(argv, 'framework')
  const n = Number(need(argv, 'n'))
  const seed = Number(need(argv, 'seed'))
  const exclude = new Set(arg(argv, 'exclude') ? readIds(need(argv, 'exclude')) : [])
  const pool = readJsonl<PoolEntry>(need(argv, 'pool')).filter((entry) => entry.framework === framework && !exclude.has(entry.id))
  const strata = new Map<string, PoolEntry[]>()
  for (const entry of pool) {
    const key = `${entry.source}/${entry.granularity}/${entry.assertionChanged ? 'assert' : 'noassert'}`
    strata.set(key, [...(strata.get(key) ?? []), entry])
  }
  const random = mulberry32(seed)
  // Proportional allocation with at least one per stratum; largest remainders
  // take what rounding left over, so small strata are represented, not skipped.
  const keys = [...strata.keys()].sort()
  const shares = keys.map((key) => ((strata.get(key) ?? []).length / pool.length) * n)
  const counts = shares.map((share) => Math.max(1, Math.floor(share)))
  let remaining = n - counts.reduce((sum, count) => sum + count, 0)
  const byRemainder = keys.map((_, i) => i).sort((a, b) => (shares[b] - Math.floor(shares[b])) - (shares[a] - Math.floor(shares[a])))
  for (const i of byRemainder) {
    if (remaining <= 0) break
    if (counts[i] < (strata.get(keys[i]) ?? []).length) { counts[i]++; remaining-- }
  }
  const chosen: PoolEntry[] = []
  keys.forEach((key, i) => chosen.push(...shuffle(strata.get(key) ?? [], random).slice(0, counts[i])))
  const out = need(argv, 'out')
  fs.writeFileSync(out, [`# sample framework=${framework} n=${n} seed=${seed} pool=${pool.length}`, ...chosen.map((entry) => entry.id)].join('\n') + '\n')
  console.log(`sampled ${chosen.length}/${n} from ${pool.length}`, Object.fromEntries(keys.map((key, i) => [key, `${counts[i]}/${(strata.get(key) ?? []).length}`])))
}

function cmdShow(argv: string[]): void {
  const ids = (arg(argv, 'ids') ?? '').split(',').filter(Boolean)
  const context = Number(arg(argv, 'context') ?? '1')
  const max = Number(arg(argv, 'max') ?? '90')
  const corpus = corpusById(need(argv, 'corpus'), new Set(ids))
  for (const id of ids) {
    const pair = corpus.get(id)
    if (!pair) { console.log(`### ${id} — not in corpus`); continue }
    const lines = unifiedDiff(pair.before, pair.after, context).split('\n')
    console.log(`\n### ${pair.id} · ${pair.source}/${pair.granularity} · ${pair.framework} · public=${pair.publicOk} · ${path.basename(pair.filePath)} · ${pair.timestamp.slice(0, 10)}`)
    console.log(lines.slice(0, max).join('\n'))
    if (lines.length > max) console.log(`… ${lines.length - max} more diff lines`)
  }
}

function cmdSurface(argv: string[]): void {
  const ids = readIds(need(argv, 'ids'))
  const corpus = corpusById(need(argv, 'corpus'), new Set(ids))
  const matchers = new Map<string, number>()
  const strengths = new Map<string, number>()
  const forms = { negated: 0, soft: 0, poll: 0, settlement: 0, withOptions: 0 }
  const shapes = new Map<string, number>()
  let predicates = 0, unparsed = 0, parseErrors = 0, sides = 0, wrapped = 0, tests = 0
  const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1) }
  for (const id of ids) {
    const pair = corpus.get(id)
    if (!pair) continue
    for (const source of [pair.before, pair.after]) {
      sides++
      const side = extractSide(source, sideFile(pair))
      if (side.wrapped) wrapped++
      if (side.result.parseError) { parseErrors++; continue }
      for (const test of side.result.tests) {
        tests++
        unparsed += test.unparsed?.length ?? 0
        for (const predicate of test.predicates) {
          predicates++
          bump(matchers, predicate.matcher)
          bump(shapes, predicate.expected)
          if (predicate.negated) forms.negated++
          if (predicate.soft) forms.soft++
          if (predicate.poll) forms.poll++
          if (predicate.settlement) forms.settlement++
          if (predicate.optionKeys) forms.withOptions++
          const strength = strengthOf(predicate)
          bump(strengths, strength.kind === 'ranked' ? `${strength.tier}/${strength.family}` : `unclassifiable: ${strength.reason.replace(/ toBe\w+$/, ' <name>')}`)
        }
      }
    }
  }
  const sorted = (map: Map<string, number>): [string, number][] => [...map.entries()].sort((a, b) => b[1] - a[1])
  console.log(`pairs=${ids.length} sides=${sides} wrapped=${wrapped} parseErrors=${parseErrors} tests=${tests} predicates=${predicates} unparsed=${unparsed}`)
  console.log('forms', forms)
  console.log('shapes', Object.fromEntries(sorted(shapes)))
  console.log('matchers', Object.fromEntries(sorted(matchers)))
  console.log('strength', Object.fromEntries(sorted(strengths)))
}

function cmdClassify(argv: string[]): void {
  const ids = readIds(need(argv, 'ids'))
  const corpus = corpusById(need(argv, 'corpus'), new Set(ids))
  const predictions: Prediction[] = []
  for (const id of ids) {
    const pair = corpus.get(id)
    if (pair) predictions.push(classifyPair(pair))
  }
  fs.writeFileSync(need(argv, 'out'), predictions.map((prediction) => JSON.stringify(prediction)).join('\n') + '\n')
  const verdicts = new Map<string, number>()
  for (const prediction of predictions) verdicts.set(prediction.verdict, (verdicts.get(prediction.verdict) ?? 0) + 1)
  console.log(`classified ${predictions.length}`, Object.fromEntries(verdicts))
}

// Freezing a holdout means committing to an id list AND to the classifier that
// will be scored on it: both fingerprints land in one file before any holdout
// label is read.
function cmdFreeze(argv: string[]): void {
  const ids = readIds(need(argv, 'ids'))
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  const sources = need(argv, 'sources').split(',').map((file) => ({ file, sha256: sha(fs.readFileSync(file, 'utf8')) }))
  const record = { frozenAt: new Date().toISOString(), count: ids.length, idsSha256: sha([...ids].sort().join('\n')), sources }
  fs.writeFileSync(need(argv, 'out'), JSON.stringify(record, null, 2) + '\n')
  console.log(record)
}

interface Rates { detectionStrict: number; detectionNonGreen: number; fpStrict: number; fpNonGreen: number; n: Record<string, number> }

export function score(labels: Label[], predictions: Prediction[]): { confusion: Record<string, Record<string, number>>; rates: Rates } {
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]))
  const confusion: Record<string, Record<string, number>> = {}
  const n: Record<string, number> = {}
  let weakerHitStrict = 0, weakerHitNonGreen = 0, equivalentFpStrict = 0, equivalentFpNonGreen = 0
  for (const label of labels) {
    const prediction = byId.get(label.id)
    if (!prediction || label.label === 'excluded') continue
    ;(confusion[label.label] ??= {})[prediction.verdict] = (confusion[label.label]?.[prediction.verdict] ?? 0) + 1
    n[label.label] = (n[label.label] ?? 0) + 1
    if (label.label === 'weaker') {
      if (prediction.verdict === 'weaker') weakerHitStrict++
      if (prediction.verdict === 'weaker' || prediction.verdict === 'unclassifiable') weakerHitNonGreen++
    }
    if (label.label === 'equivalent') {
      if (prediction.verdict === 'weaker') equivalentFpStrict++
      if (prediction.verdict !== 'equivalent') equivalentFpNonGreen++
    }
  }
  const pct = (num: number, den: number): number => (den ? Math.round((num / den) * 1000) / 10 : NaN)
  return {
    confusion,
    rates: {
      detectionStrict: pct(weakerHitStrict, n.weaker ?? 0),
      detectionNonGreen: pct(weakerHitNonGreen, n.weaker ?? 0),
      fpStrict: pct(equivalentFpStrict, n.equivalent ?? 0),
      fpNonGreen: pct(equivalentFpNonGreen, n.equivalent ?? 0),
      n,
    },
  }
}

function cmdScore(argv: string[]): void {
  const only = arg(argv, 'ids') ? new Set(readIds(need(argv, 'ids'))) : undefined
  const pool = new Map(readJsonl<PoolEntry>(need(argv, 'pool')).map((entry) => [entry.id, entry]))
  const labels = readJsonl<Label>(need(argv, 'labels')).filter((label) => !only || only.has(label.id))
  const predictions = readJsonl<Prediction>(need(argv, 'predictions'))
  const slices: Record<string, (label: Label) => boolean> = {
    all: () => true,
    playwright: (label) => pool.get(label.id)?.framework === 'playwright',
    vitest: (label) => pool.get(label.id)?.framework === 'vitest',
    'playwright-transcripts': (label) => pool.get(label.id)?.framework === 'playwright' && pool.get(label.id)?.source !== 'git',
  }
  for (const [name, keep] of Object.entries(slices)) {
    const subset = labels.filter(keep)
    if (!subset.length) continue
    const result = score(subset, predictions)
    console.log(`\n== ${name} (${subset.length} labelled)`)
    console.log('confusion (label → verdict):', JSON.stringify(result.confusion))
    console.log('rates %:', result.rates)
  }
}

const COMMANDS: Record<string, (argv: string[]) => void> = {
  pool: cmdPool, sample: cmdSample, show: cmdShow, surface: cmdSurface, classify: cmdClassify, freeze: cmdFreeze, score: cmdScore,
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...rest] = process.argv.slice(2)
  const run = command ? COMMANDS[command] : undefined
  if (!run) {
    console.error(`usage: bench.ts <${Object.keys(COMMANDS).join('|')}> …`)
    process.exit(2)
  }
  run(rest)
}
