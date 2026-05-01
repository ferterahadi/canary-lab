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
  file: string // absolute path to spec file
  line: number // 1-based line of the `test(...)` call
  title: string // fully-resolved test title
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

function collectSpecs(suites: PwSuite[] | undefined, rootDir: string, out: PlaywrightListEntry[]): void {
  if (!suites) return
  for (const suite of suites) {
    if (suite.specs) {
      for (const spec of suite.specs) {
        if (typeof spec.title !== 'string' || typeof spec.line !== 'number') continue
        const file = spec.file ?? suite.file
        if (!file) continue
        const abs = path.isAbsolute(file) ? file : path.resolve(rootDir, file)
        out.push({ file: abs, line: spec.line, title: spec.title })
      }
    }
    collectSpecs(suite.suites, rootDir, out)
  }
}

export interface ListPlaywrightTestsOpts {
  spawner?: PlaywrightListSpawner
  timeoutMs?: number
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
    const child = spawn(inv.command, inv.args, { cwd: inv.cwd, env: process.env })
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
