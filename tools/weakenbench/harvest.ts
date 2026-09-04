import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// WeakenBench corpus harvester. Pulls real before/after test-edit pairs out of
// the coding-agent transcripts on this machine and out of a workspace's git
// history, and writes them as one JSONL record per pair. Every downstream
// WeakenBench file (labels, splits, results) keys on the `id` emitted here.
//
// Why transcripts and not the dirty-specs store: `logs/dirty-specs/*/dirty.json`
// holds hashes only. The content of an edit exists in exactly two places — the
// agent's own tool-call record (Claude `Edit`/`Write`, Codex `apply_patch`) and,
// once committed, git. Both are read here; neither is trusted for anything but
// the text of the edit.
//
// Why the raw corpus stays OUT of the repo: most pairs are edits to private
// product code. `publicOk` marks the pairs drawn from Canary Lab's own demo
// projects, which is the subset a published benchmark may carry verbatim.
//
// Run:  tsx tools/weakenbench/harvest.ts --out ~/Documents/weakenbench-data/raw-pairs.jsonl \
//         [--claude-root ~/.claude/projects] [--codex-root ~/.codex/sessions] \
//         [--git ~/Documents/canary-lab-workspace]...

export type PairSource = 'claude' | 'codex' | 'git'
export type Framework = 'playwright' | 'vitest' | 'jest' | 'unknown'
export type Granularity = 'file' | 'fragment'

export interface RawPair {
  /** Content hash of (filePath basename, before, after) — stable across re-harvests. */
  id: string
  source: PairSource
  /** Session transcript path or commit sha. */
  origin: string
  timestamp: string | null
  cwd: string | null
  filePath: string
  framework: Framework
  /** `file` = whole file before/after (per-test attribution possible downstream);
   *  `fragment` = only the replaced text is known. */
  granularity: Granularity
  tool: string
  author?: string
  before: string
  after: string
  /** Drawn from a Canary Lab demo/template project or a public open-source clone — safe to publish verbatim. */
  publicOk: boolean
  /** How many further occurrences collapsed into this record (Codex guardian
   *  sessions echo every planned patch several times). */
  duplicates: number
}

const TEST_FILE = /\.(spec|test|e2e)\.(ts|tsx|js|mjs|cjs)$/

// Paths whose content is Canary Lab's own public demo material. Everything else
// is private until a human says otherwise — the list is deliberately narrow.
const PUBLIC_PATH_MARKERS = [
  '/canary-lab-demo-',
  '/canary-flight-lab-',
  '/canary-demo-lab-',
  '/demo-project/',
  '/Documents/canary-lab/templates/',
  '/Documents/canary-lab/tools/fixtures/',
  '/Documents/canary-lab-wt/',
  '/Documents/canary-lab/apps/',
  '/Documents/canary-lab/shared/',
  '/scratchpad/gs-live/',
  // Clones of public open-source repositories, harvested for the Phase 0b holdout.
  '/weakenbench-data/oss/',
]

export function isPublicPath(filePath: string): boolean {
  return PUBLIC_PATH_MARKERS.some((marker) => filePath.includes(marker))
}

export function detectFramework(filePath: string, ...sources: string[]): Framework {
  const text = sources.join('\n')
  if (/@playwright\/test|canary-lab\/feature-support|\btest\.step\(|\bpage\.(goto|locator|getBy)|expect\(page\)/.test(text)) return 'playwright'
  if (/from ['"]vitest['"]|\bvi\.(fn|mock|spyOn)\(/.test(text)) return 'vitest'
  if (/\bjest\.(fn|mock|spyOn)\(|from ['"]@jest\/globals['"]|\bdescribe\(|\bbeforeEach\(/.test(text)) return 'jest'
  if (/\/e2e\//.test(filePath)) return 'playwright'
  return 'unknown'
}

function pairId(filePath: string, before: string, after: string): string {
  return createHash('sha256')
    .update(path.basename(filePath))
    .update('\0')
    .update(before)
    .update('\0')
    .update(after)
    .digest('hex')
    .slice(0, 16)
}

class Corpus {
  private readonly pairs = new Map<string, RawPair>()

  add(pair: Omit<RawPair, 'id' | 'duplicates'>): void {
    if (pair.before === pair.after) return
    const id = pairId(pair.filePath, pair.before, pair.after)
    const existing = this.pairs.get(id)
    if (existing) {
      existing.duplicates += 1
      return
    }
    this.pairs.set(id, { id, ...pair, duplicates: 0 })
  }

  list(): RawPair[] {
    return [...this.pairs.values()]
  }
}

function walkJsonl(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // an unreadable directory contributes nothing
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  visit(root)
  return out
}

function* jsonLines(file: string): Generator<Record<string, unknown>> {
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      yield JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // a truncated trailing line is normal in a live transcript
    }
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────

interface PendingToolUse {
  name: string
  input: Record<string, unknown>
  timestamp: string | null
  cwd: string | null
}

interface ToolResultFile {
  filePath?: string
  content?: string
  startLine?: number
  numLines?: number
  totalLines?: number
}

interface ToolUseResult {
  type?: string
  originalFile?: string | null
  file?: ToolResultFile
}

function contentBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = record.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
}

function applyEdit(before: string, oldText: string, newText: string, replaceAll: boolean): string | null {
  if (!before.includes(oldText)) return null
  return replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, () => newText)
}

function harvestClaudeSession(file: string, corpus: Corpus): void {
  const pending = new Map<string, PendingToolUse>()
  // Latest known content per path within this session: full Reads, Writes and
  // successfully reconstructed Edits all feed it. It is what turns a fragment-only
  // `Edit` into a whole-file pair when the tool result carries no `originalFile`.
  const state = new Map<string, string>()

  const emit = (tool: string, use: PendingToolUse, filePath: string, before: string, after: string, granularity: Granularity): void => {
    corpus.add({
      source: 'claude',
      origin: file,
      timestamp: use.timestamp,
      cwd: use.cwd,
      filePath,
      framework: detectFramework(filePath, before, after),
      granularity,
      tool,
      before,
      after,
      publicOk: isPublicPath(filePath),
    })
  }

  const settleEdit = (use: PendingToolUse, result: ToolUseResult | undefined): void => {
    const filePath = String(use.input.file_path ?? '')
    const edits = use.name === 'MultiEdit'
      ? ((use.input.edits as { old_string: string; new_string: string; replace_all?: boolean }[] | undefined) ?? [])
      : [{
          old_string: String(use.input.old_string ?? ''),
          new_string: String(use.input.new_string ?? ''),
          replace_all: Boolean(use.input.replace_all),
        }]
    const before = result?.originalFile ?? state.get(filePath)
    if (before !== undefined) {
      let after: string | null = before
      for (const edit of edits) {
        after = applyEdit(after, edit.old_string, edit.new_string, Boolean(edit.replace_all))
        if (after === null) break
      }
      if (after !== null) {
        state.set(filePath, after)
        emit(use.name, use, filePath, before, after, 'file')
        return
      }
      state.delete(filePath) // stale: the file changed outside what this session saw
    }
    for (const edit of edits) emit(use.name, use, filePath, edit.old_string, edit.new_string, 'fragment')
  }

  const settleWrite = (use: PendingToolUse, result: ToolUseResult | undefined): void => {
    const filePath = String(use.input.file_path ?? '')
    const after = String(use.input.content ?? '')
    const before = result?.originalFile ?? state.get(filePath)
    state.set(filePath, after)
    // A `create` has no before; it is an added test, not an edit to one.
    if (before === undefined || result?.type === 'create') return
    emit('Write', use, filePath, before, after, 'file')
  }

  const settleRead = (use: PendingToolUse, result: ToolUseResult | undefined): void => {
    const info = result?.file
    if (!info || typeof info.content !== 'string') return
    const partial = (info.startLine ?? 1) !== 1
      || (info.numLines !== undefined && info.totalLines !== undefined && info.numLines < info.totalLines)
    if (partial) return
    state.set(String(use.input.file_path ?? info.filePath ?? ''), info.content)
  }

  for (const record of jsonLines(file)) {
    if (record.type === 'assistant') {
      for (const block of contentBlocks(record)) {
        if (block.type !== 'tool_use') continue
        const input = (block.input as Record<string, unknown> | undefined) ?? {}
        const filePath = String(input.file_path ?? '')
        const name = String(block.name)
        if (!TEST_FILE.test(filePath)) continue
        if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write' && name !== 'Read') continue
        pending.set(String(block.id), {
          name,
          input,
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
        })
      }
      continue
    }
    if (record.type !== 'user') continue
    for (const block of contentBlocks(record)) {
      if (block.type !== 'tool_result') continue
      const use = pending.get(String(block.tool_use_id))
      if (!use) continue
      pending.delete(String(block.tool_use_id))
      if (block.is_error) continue
      const result = typeof record.toolUseResult === 'object' && record.toolUseResult !== null
        ? (record.toolUseResult as ToolUseResult)
        : undefined
      if (use.name === 'Read') settleRead(use, result)
      else if (use.name === 'Write') settleWrite(use, result)
      else settleEdit(use, result)
    }
  }
  // A tool call whose result never arrived in this file (the transcript was cut,
  // or the result lives in a sibling subagent log) is still a real edit; settle
  // it from what the session had seen.
  for (const use of pending.values()) {
    if (use.name === 'Write') settleWrite(use, undefined)
    else if (use.name !== 'Read') settleEdit(use, undefined)
  }
}

// ── Codex ───────────────────────────────────────────────────────────────────

const PATCH_BLOCK = /\*\*\* Begin Patch\n([\s\S]*?)\*\*\* End Patch/g
const FILE_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+)$/

interface PatchHunk {
  before: string
  after: string
}

// apply_patch's Update section is a sequence of `@@`-headed hunks whose lines
// carry a one-character prefix: ' ' context, '-' removed, '+' added. Context
// lines belong to both sides, so each hunk reconstructs a before and an after
// fragment around the change.
export function parseUpdateHunks(sectionLines: string[]): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: { before: string[]; after: string[] } | null = null
  const flush = (): void => {
    if (current && (current.before.length || current.after.length)) {
      hunks.push({ before: current.before.join('\n'), after: current.after.join('\n') })
    }
    current = null
  }
  for (const line of sectionLines) {
    if (line.startsWith('@@')) {
      flush()
      current = { before: [], after: [] }
      continue
    }
    if (line.startsWith('*** ')) continue // `*** Move to:` and end-of-file markers
    current ??= { before: [], after: [] }
    const prefix = line[0]
    const body = line.slice(1)
    if (prefix === '-') current.before.push(body)
    else if (prefix === '+') current.after.push(body)
    else {
      current.before.push(body)
      current.after.push(body)
    }
  }
  flush()
  return hunks
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* stringsIn(item)
}

function harvestCodexSession(file: string, corpus: Corpus): void {
  let cwd: string | null = null
  for (const record of jsonLines(file)) {
    if (record.type === 'session_meta') {
      const payload = record.payload as { cwd?: string } | undefined
      cwd = payload?.cwd ?? null
      continue
    }
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null
    for (const text of stringsIn(record)) {
      if (!text.includes('*** Begin Patch')) continue
      for (const match of text.matchAll(PATCH_BLOCK)) {
        const lines = match[1].split('\n')
        let header: RegExpMatchArray | null = null
        let section: string[] = []
        const flush = (): void => {
          if (header && header[1] === 'Update' && TEST_FILE.test(header[2])) {
            const filePath = header[2]
            for (const hunk of parseUpdateHunks(section)) {
              corpus.add({
                source: 'codex',
                origin: file,
                timestamp,
                cwd,
                filePath,
                framework: detectFramework(filePath, hunk.before, hunk.after),
                granularity: 'fragment',
                tool: 'apply_patch',
                before: hunk.before,
                after: hunk.after,
                publicOk: isPublicPath(filePath),
              })
            }
          }
          section = []
        }
        for (const line of lines) {
          const fileHeader = FILE_HEADER.exec(line)
          if (fileHeader) {
            flush()
            header = fileHeader
            continue
          }
          section.push(line)
        }
        flush()
      }
    }
  }
}

// ── git ─────────────────────────────────────────────────────────────────────

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null // a path that does not exist at `sha^` is an added file, not an edit
  }
}

function harvestGitHistory(repo: string, corpus: Corpus): void {
  const log = git(repo, ['log', '--format=%x01%H%x09%at%x09%an', '--name-only', '--diff-filter=M', '--', '*.spec.ts', '*.spec.js', '*.test.ts', '*.test.js', '*.e2e.ts'])
  if (!log) return
  for (const chunk of log.split('\x01')) {
    const [head, ...files] = chunk.split('\n')
    if (!head) continue
    const [sha, epoch, author] = head.split('\t')
    for (const rel of files) {
      if (!rel || !TEST_FILE.test(rel)) continue
      const before = git(repo, ['show', `${sha}^:${rel}`])
      const after = git(repo, ['show', `${sha}:${rel}`])
      if (before === null || after === null) continue
      const filePath = path.join(repo, rel)
      corpus.add({
        source: 'git',
        origin: sha,
        timestamp: new Date(Number(epoch) * 1000).toISOString(),
        cwd: repo,
        filePath,
        framework: detectFramework(filePath, before, after),
        granularity: 'file',
        tool: 'commit',
        author,
        before,
        after,
        publicOk: isPublicPath(filePath),
      })
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface Options {
  out: string
  claudeRoots: string[]
  codexRoots: string[]
  gitRepos: string[]
}

function parseArgs(argv: string[]): Options {
  const options: Options = { out: '', claudeRoots: [], codexRoots: [], gitRepos: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--out') options.out = value
    else if (flag === '--claude-root') options.claudeRoots.push(value)
    else if (flag === '--codex-root') options.codexRoots.push(value)
    else if (flag === '--git') options.gitRepos.push(value)
    else continue
    i += 1
  }
  if (!options.out) throw new Error('--out <file> is required')
  if (!options.claudeRoots.length) options.claudeRoots.push(path.join(os.homedir(), '.claude', 'projects'))
  if (!options.codexRoots.length) options.codexRoots.push(path.join(os.homedir(), '.codex', 'sessions'))
  return options
}

function summarize(pairs: RawPair[]): string {
  const rows = new Map<string, number>()
  const bump = (key: string): void => {
    rows.set(key, (rows.get(key) ?? 0) + 1)
  }
  for (const pair of pairs) {
    bump(`${pair.source}\t${pair.framework}\t${pair.granularity}\t${pair.publicOk ? 'public' : 'private'}`)
  }
  const lines = ['source\tframework\tgranularity\tvisibility\tpairs']
  for (const [key, count] of [...rows.entries()].sort()) lines.push(`${key}\t${count}`)
  lines.push(`total\t\t\t\t${pairs.length}`)
  return lines.join('\n')
}

export function harvest(options: Options): RawPair[] {
  const corpus = new Corpus()
  for (const root of options.claudeRoots) for (const file of walkJsonl(root)) harvestClaudeSession(file, corpus)
  for (const root of options.codexRoots) for (const file of walkJsonl(root)) harvestCodexSession(file, corpus)
  for (const repo of options.gitRepos) harvestGitHistory(repo, corpus)
  return corpus.list().sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.id.localeCompare(b.id))
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2))
  const pairs = harvest(options)
  fs.mkdirSync(path.dirname(options.out), { recursive: true })
  fs.writeFileSync(options.out, pairs.map((pair) => JSON.stringify(pair)).join('\n') + '\n')
  console.log(summarize(pairs))
  console.log(`\nwrote ${pairs.length} pairs → ${options.out}`)
}
