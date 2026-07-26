#!/usr/bin/env node
// Mechanical half of the repo's code conventions. The judgement half — why a
// comment exists, when to delete an unreachable arm instead of testing around
// it — lives in `.claude/skills/cl_code-conventions/SKILL.md`, because no linter
// can express it. Anything a tool CAN catch belongs here instead of in a doc.
//
// Run: node tools/check-conventions.mjs   (or `npm run check:conventions`)
//
// Dependency-free and single-pass so a PostToolUse hook can run it on every edit
// without being felt (~0.2s over ~380 files).
//
// TWO THINGS THAT BIT THE FIRST DRAFT, both worth keeping in mind before adding
// a rule here:
//   1. Do NOT strip comments before looking for a MISSING comment. The first
//      version stripped comment-only lines, which turned every properly
//      explained multi-line catch into a violation — 66 false positives.
//   2. Pattern rules run on .ts/.tsx only, never on this tools/ tree. A checker's
//      own source contains the patterns it hunts; the first version flagged
//      itself and check-feature-boundaries.mjs.
//
// BASELINES: three rules have pre-existing violations, listed explicitly rather
// than softened, so a NEW violation fails while existing debt stays visible. A
// baseline entry that no longer violates is ALSO a failure — that is what stops
// the list outliving its reason (same trick as ALLOWED_DEEP in
// check-feature-boundaries.mjs).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(import.meta.dirname, '..')
const ROOTS = ['apps', 'shared', 'tools']

// Coverage-gate floor. Percentage alone does not prove scope: a file lifted out
// of the gate keeps it at 100% while covering less. Raise this when it grows.
const MIN_GATED_FILES = 187

// `console.*` is CLI output, not server logging. These trees ARE the CLI.
const CONSOLE_OK = ['apps/cli/', 'shared/cli-ui/', 'tools/']

// `.tsx` files that are a module of several exports rather than one component,
// so PascalCase would misdescribe them.
const LOWERCASE_TSX_OK = new Map([
  ['atoms.tsx', 'a set of shared primitives, not one component'],
  ['main.tsx', 'the app entry point'],
  ['invalidation.tsx', 'query-invalidation helpers'],
  ['stage-meta.tsx', 'stage metadata tables'],
  ['external-client-branding.tsx', 'per-client branding lookups'],
])

const BASELINE = {
  'kebab-case': new Map([
    ['shared/configs/loadEnv.ts', 'rename crosses a published path — do it deliberately, not in passing'],
    ['apps/web/src/features/config/components/useEditableSlice.ts', 'the other four hooks are use-*.ts; this one predates them'],
  ]),
  'no-v8-ignore': new Map([
    ['apps/web-server/src/features/config/logic/feature-authoring.ts', '6 pragmas — path-traversal + validated-scaffold guards'],
    ['apps/web-server/src/features/runs/logic/runtime/trace-enrichment.ts', '1 pragma — corrupt-install branch'],
    ['apps/web/src/features/runs/state/RunsContext.tsx', '3 pragmas — timer/socket cleanup closures'],
    ['apps/web/src/shared/shell/McpPromoContext.tsx', '1 pragma — callback only wired while a dialog is mounted'],
  ]),
  'no-console': new Map([
    ['apps/web-server/src/features/runs/logic/runtime/env-switcher/switch.ts', 'is itself a CLI entry point'],
    ['apps/web-server/src/shared/feature-loader.ts', 'warns on a broken feature.config at load time'],
  ]),
}

const failures = []
const hits = Object.fromEntries(Object.keys(BASELINE).map((k) => [k, new Set()]))

// Report unless this file is a recorded exception for this rule.
function check(rule, rel, message, fix) {
  if (BASELINE[rule]?.has(rel)) { hits[rule].add(rel); return }
  failures.push({ file: rel, message, fix })
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const files = ROOTS.filter((r) => existsSync(path.join(REPO, r)))
  .flatMap((r) => walk(path.join(REPO, r)))
  .map((p) => path.relative(REPO, p).split(path.sep).join('/'))

const SOURCE = /\.(ts|tsx|mjs)$/
const TEST = /\.test\.tsx?$/
const sources = files.filter((f) => SOURCE.test(f))

for (const rel of sources) {
  const base = path.basename(rel)
  const isTest = TEST.test(rel)
  const isTool = rel.startsWith('tools/')
  const text = readFileSync(path.join(REPO, rel), 'utf8')
  const lineOf = (index) => text.slice(0, index).split('\n').length
  // Comment-free view, for rules that must not fire on prose ABOUT the pattern.
  const code = text.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n')

  // ── naming ───────────────────────────────────────────────────────────────
  // Test filenames mirror the module under test, so they inherit its case and
  // are not checked here — the module itself is.
  if (!isTest) {
    if (/\.(ts|mjs)$/.test(base) && !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9-]+)*\.(ts|mjs)$/.test(base)) {
      check('kebab-case', rel, `"${base}" is not kebab-case`, 'rename it — every .ts/.mjs source file here is kebab-case, hooks included (use-run-start.ts)')
    }
    if (base.endsWith('.tsx') && !/^[A-Z]/.test(base) && !LOWERCASE_TSX_OK.has(base)) {
      check('component-case', rel, `"${base}" is lowercase`, 'a .tsx exporting one component is PascalCase; if it is a module of several exports, add it to LOWERCASE_TSX_OK with a reason')
    }
  }

  // ── an empty catch must say why (raw text: we are looking for a comment) ──
  for (const m of text.matchAll(/catch\s*(\([^)]*\))?\s*\{\s*\}/g)) {
    check('explained-catch', `${rel}:${lineOf(m.index)}`, 'empty catch with no reason', "swallowing is fine, silence is not — put the reason inline: catch { /* already gone */ }")
  }

  if (isTool) continue // a checker's own source contains the patterns below

  // ── banned coverage pragma ───────────────────────────────────────────────
  if (/v8 ignore/.test(text)) {
    check('no-v8-ignore', rel, 'uses a /* v8 ignore */ pragma', 'delete the unreachable arm, or make it unrepresentable in the type; a file-level exclude carrying a per-arm rationale is the last resort')
  }

  // ── console.* belongs to the CLI ─────────────────────────────────────────
  if (!isTest && /console\.(log|error|warn|info|debug)\s*\(/.test(code) && !CONSOLE_OK.some((p) => rel.startsWith(p))) {
    check('no-console', rel, 'writes to console outside the CLI trees', 'take an injected `log?: (msg: string, err?: unknown) => void` — server output has to be capturable')
  }

  // ── aliases are bundler-only ─────────────────────────────────────────────
  if (!rel.startsWith('apps/web/') && /from '@(\/|shared\/)/.test(code)) {
    check('alias-scope', rel, "uses a '@/…' or '@shared/…' alias outside apps/web", 'only Vite rewrites these; tsc emits the specifier verbatim, so it ships to dist/ and breaks the installed package. Use a relative path')
  }
}

// ── tests live with the code they test ─────────────────────────────────────
for (const rel of files.filter((f) => TEST.test(f))) {
  const dir = path.dirname(rel)
  if (path.basename(dir) === '__tests__') {
    check('test-location', rel, 'lives in a __tests__ directory', 'this repo co-locates — put it in the same directory as the code it tests')
    continue
  }
  const siblings = readdirSync(path.join(REPO, dir)).filter((f) => SOURCE.test(f) && !TEST.test(f))
  if (siblings.length === 0) {
    check('test-location', rel, 'has no source file in its directory', 'move it next to the code it tests')
  }
}

// ── coverage scope floor ───────────────────────────────────────────────────
// Opt-in via --coverage, and NOT because it is expensive. A scoped run
// (`vitest --coverage.include=<one file>`) leaves a one-file lcov.info behind,
// which would make the edit hook fail on every subsequent edit for reasons that
// have nothing to do with the edit. CI runs the full suite and then passes the
// flag, which is the only context where the count means anything.
const wantCoverage = process.argv.includes('--coverage')
const lcov = path.join(REPO, 'coverage/lcov.info')
let coverageNote = wantCoverage ? 'no coverage/lcov.info — run `npm run test:coverage` first' : 'not checked (pass --coverage)'
if (wantCoverage && existsSync(lcov)) {
  const gated = (readFileSync(lcov, 'utf8').match(/^SF:/gm) ?? []).length
  if (gated < MIN_GATED_FILES) {
    check('coverage-scope', 'coverage/lcov.info', `gate covers ${gated} files, floor is ${MIN_GATED_FILES}`, 'a file left the gate. 100% over fewer files is not the same gate — restore it, or raise MIN_GATED_FILES deliberately')
  }
  coverageNote = `${gated} files gated (floor ${MIN_GATED_FILES})`
}

// ── a baseline entry that stopped violating must be deleted ────────────────
for (const [rule, entries] of Object.entries(BASELINE)) {
  for (const [file, reason] of entries) {
    if (hits[rule].has(file)) continue
    failures.push({
      file,
      message: `BASELINE["${rule}"] still lists this file ("${reason}") but it no longer violates`,
      fix: 'delete the entry so the list cannot outlive its reason',
    })
  }
}

const debt = Object.values(hits).reduce((n, s) => n + s.size, 0)

if (failures.length === 0) {
  console.log(`✔ conventions clean — ${sources.length} source files, ${debt} baselined, coverage: ${coverageNote}`)
  process.exit(0)
}

for (const f of failures) console.error(`✘ ${f.file}\n    ${f.message}\n    → ${f.fix}`)
console.error(`\n${failures.length} convention problem(s). Rules: .claude/skills/cl_code-conventions/SKILL.md`)
process.exit(1)
