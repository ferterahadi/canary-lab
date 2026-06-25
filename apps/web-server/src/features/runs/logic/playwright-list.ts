import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

// Asks Playwright to enumerate the resolved test list for a feature directory
// using `npx playwright test --list --reporter=json`. Playwright evaluates the
// spec modules so loops, parameterised tests, and `${var}` template literals
// expand to their real titles.
//
// Returns one entry per resolved test, or `null` if the spawn/parse fails — in
// which case callers should fall back to the AST extractor.

export interface PlaywrightListEntry {
  // Absolute path to the *entry-point* spec file Playwright loaded — i.e.
  // the top-level suite's file. For direct `test(...)` calls this equals
  // `originFile`. For tests defined inside a helper (e.g. a factory imported
  // by the spec) this is the importing spec, NOT the helper.
  file: string
  // 1-based line of the call site. For helper-defined tests this is the
  // line of the `test(...)` invocation inside the helper, since Playwright
  // reports the literal definition site.
  line: number
  title: string
  // Absolute path to the file where `test(...)` literally lives. Equal to
  // `file` for direct tests; differs when the spec calls into a helper.
  originFile: string
  originLine: number
}

interface PwSpec {
  title: string
  file?: string
  line?: number
  column?: number
  tests?: unknown[]
}

interface PwSuite {
  title?: string
  file?: string
  specs?: PwSpec[]
  suites?: PwSuite[]
}

interface PwListReport {
  config?: { rootDir?: string }
  suites?: PwSuite[]
}

export interface PlaywrightListSpawn {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export type PlaywrightListSpawner = (featureDir: string) => PlaywrightListSpawn

export const defaultPlaywrightListSpawner: PlaywrightListSpawner = (featureDir) => ({
  command: 'npx',
  args: ['playwright', 'test', '--list', '--reporter=json'],
  cwd: featureDir,
})

interface CacheEntry {
  signature: string
  entries: PlaywrightListEntry[]
}

const cache = new Map<string, CacheEntry>()

function cacheSignature(featureDir: string): string {
  const e2eDir = path.join(featureDir, 'e2e')
  if (!fs.existsSync(e2eDir)) return 'no-e2e'
  const parts: string[] = []
  for (const entry of fs.readdirSync(e2eDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      const p = path.join(e2eDir, entry.name)
      try {
        const stat = fs.statSync(p)
        parts.push(`${entry.name}:${stat.mtimeMs}:${stat.size}`)
      } catch { /* ignore */ }
    }
  }
  return parts.join('|')
}

function collectSpecs(
  suites: PwSuite[] | undefined,
  rootDir: string,
  out: PlaywrightListEntry[],
  rootFile?: string,
): void {
  if (!suites) return
  for (const suite of suites) {
    // The outermost suite Playwright emits per loaded spec file holds the
    // entry-point file path. Lock it in on the first ancestor that carries
    // a file — inner suites (e.g. created by a helper's `test.describe`)
    // must NOT overwrite it, otherwise helper-defined tests get attributed
    // to the helper instead of the spec that imported it.
    const nextRoot = rootFile ?? suite.file
    if (suite.specs) {
      for (const spec of suite.specs) {
        if (typeof spec.title !== 'string' || typeof spec.line !== 'number') continue
        const originRaw = spec.file ?? suite.file
        if (!originRaw) continue
        const originAbs = path.isAbsolute(originRaw) ? originRaw : path.resolve(rootDir, originRaw)
        const entryRaw = nextRoot ?? originRaw
        const entryAbs = path.isAbsolute(entryRaw) ? entryRaw : path.resolve(rootDir, entryRaw)
        out.push({
          file: entryAbs,
          line: spec.line,
          title: spec.title,
          originFile: originAbs,
          originLine: spec.line,
        })
      }
    }
    collectSpecs(suite.suites, rootDir, out, nextRoot)
  }
}

export interface ListPlaywrightTestsOpts {
  spawner?: PlaywrightListSpawner
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export async function listPlaywrightTests(
  featureDir: string,
  opts: ListPlaywrightTestsOpts = {},
): Promise<PlaywrightListEntry[] | null> {
  const signature = cacheSignature(featureDir)
  const cached = cache.get(featureDir)
  if (cached && cached.signature === signature) return cached.entries

  const spawner = opts.spawner ?? defaultPlaywrightListSpawner
  const timeoutMs = opts.timeoutMs ?? 15_000
  const inv = spawner(featureDir)

  const stdout = await new Promise<string | null>((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const child = spawn(inv.command, inv.args, {
      cwd: inv.cwd,
      env: { ...process.env, ...(opts.env ?? {}), ...(inv.env ?? {}) },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(null)
    }, timeoutMs)
    child.stdout.on('data', (b) => { out += b.toString() })
    child.stderr.on('data', (b) => { err += b.toString() })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // `--list` exits 0 when discovery succeeded; any non-zero indicates a
      // discovery failure and stdout may not be valid JSON.
      if (code !== 0) {
        // Attach stderr to help debugging; consumers ignore the value but logs help.
        if (err) process.stderr.write(`[playwright-list] exit ${code}: ${err.slice(0, 500)}\n`)
        resolve(null)
        return
      }
      resolve(out)
    })
  })

  if (stdout === null) return null

  let report: PwListReport
  try {
    report = JSON.parse(stdout) as PwListReport
  } catch {
    return null
  }

  const rootDir = report.config?.rootDir ?? featureDir
  const entries: PlaywrightListEntry[] = []
  collectSpecs(report.suites, rootDir, entries)

  cache.set(featureDir, { signature, entries })
  return entries
}

export function clearPlaywrightListCache(): void {
  cache.clear()
}
