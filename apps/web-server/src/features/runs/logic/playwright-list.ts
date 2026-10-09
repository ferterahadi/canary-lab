import { listSpecFiles, readSpecSource } from '../../../../../../shared/spec-files'
import { createHash } from 'node:crypto'
import { captureValidationProcess } from '../../../shared/capture-validation-process'
import path from 'path'

// Asks Playwright to enumerate the resolved test list for a feature directory
// using `npx playwright test --list --reporter=json`. Playwright evaluates the
// spec modules so loops, parameterised tests, and `${var}` template literals
// expand to their real titles.
//
// Returns one entry per resolved test, or `null` if the spawn/parse fails — in
// which case callers should fall back to the AST extractor.

export interface PlaywrightListEntry {
  /** A syntax-only declaration whose generated titles need reporter enrichment. */
  unresolvedTitle?: boolean
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
  args: ['--no-install', 'playwright', 'test', '--list', '--reporter=json'],
  cwd: featureDir,
})

interface CacheEntry {
  signature: string
  entries: PlaywrightListEntry[]
}

const cache = new Map<string, CacheEntry>()

function cacheSignature(featureDir: string): string {
  return listSpecFiles(featureDir).map((file) => {
    const digest = createHash('sha256').update(readSpecSource(file)).digest('hex')
    return `${path.relative(featureDir, file)}:${digest}`
  }).join('|')
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

/** Playwright puts discovery errors after its full config in JSON stdout.
 *  Surface those messages first so a missing import is not buried in settings. */
export function discoveryFailureOutput(stdout: string, stderr: string): string {
  try {
    const report: unknown = JSON.parse(stdout)
    if (report && typeof report === 'object' && 'errors' in report && Array.isArray(report.errors)) {
      const messages = report.errors.flatMap((error: unknown) => (
        error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? [error.message] : []
      ))
      if (messages.length) return messages.join('\n\n').slice(0, 8000)
    }
  } catch { /* Non-JSON compile errors still carry useful stdout/stderr. */ }
  return `${stderr}\n${stdout}`.trim().slice(0, 8000)
}

export interface ListPlaywrightTestsOpts {
  /** Repair verification must execute Playwright even when spec timestamps match. */
  fresh?: boolean
  spawner?: PlaywrightListSpawner
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Called with whatever stderr/stdout the run produced when discovery fails
   *  (non-zero exit, spawn error, timeout, unparseable JSON) — lets callers
   *  surface the compile/list errors instead of just seeing `null`. */
  onDiagnostics?: (text: string) => void
}

export async function listPlaywrightTests(
  featureDir: string,
  opts: ListPlaywrightTestsOpts = {},
): Promise<PlaywrightListEntry[] | null> {
  if (opts.fresh) cache.delete(featureDir)
  const cached = cache.get(featureDir)
  const cachedSignature = cached ? cacheSignature(featureDir) : undefined
  if (cached && cached.signature === cachedSignature) return cached.entries

  const spawner = opts.spawner ?? defaultPlaywrightListSpawner
  const timeoutMs = opts.timeoutMs ?? 15_000
  const inv = spawner(featureDir)

  const discovery = captureValidationProcess({
    command: inv.command,
    args: inv.args,
    cwd: inv.cwd,
    env: { ...process.env, ...(opts.env ?? {}), ...(inv.env ?? {}) },
    timeoutMs,
  }).then((result): string | null => {
    if (result.kind === 'timeout') {
      opts.onDiagnostics?.(`playwright test --list timed out after ${timeoutMs}ms\n${result.stderr}`.trim())
      return null
    }
    if (result.kind === 'spawn-error') {
      opts.onDiagnostics?.(`playwright test --list failed to spawn: ${String(result.error)}`)
      return null
    }
    if (result.code === 0) return result.stdout
    // Playwright reports discovery errors inside JSON stdout; npm notices on
    // stderr must not displace the actual failure or trigger a duplicate report.
    const failure = discoveryFailureOutput(result.stdout, result.stderr)
    opts.onDiagnostics?.(`playwright test --list exited with code ${result.code}\n${failure}`.trim())
    if (failure) process.stderr.write(`[playwright-list] exit ${result.code} in ${inv.cwd}: ${failure.slice(0, 500)}\n`)
    return null
  })

  // Start the cold Playwright process before source enrichment pays its reads.
  const signature = cachedSignature ?? cacheSignature(featureDir)
  const stdout = await discovery
  if (stdout === null) return null

  let report: PwListReport
  try {
    report = JSON.parse(stdout) as PwListReport
  } catch {
    opts.onDiagnostics?.(`playwright test --list produced unparseable JSON output:\n${stdout.slice(0, 2000)}`)
    return null
  }

  const rootDir = report.config?.rootDir ?? featureDir
  const entries: PlaywrightListEntry[] = []
  collectSpecs(report.suites, rootDir, entries)

  if (signature === cacheSignature(featureDir)) cache.set(featureDir, { signature, entries })
  else cache.delete(featureDir)
  return entries
}

export function clearPlaywrightListCache(): void {
  cache.clear()
}
