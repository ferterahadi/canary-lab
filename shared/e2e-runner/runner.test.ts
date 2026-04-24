import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { FeatureConfig } from '../launcher/types'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-run-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

const PATH_ROOT = mkTmp()
const FEATURES_DIR = path.join(PATH_ROOT, 'features')
const LOGS_DIR = path.join(PATH_ROOT, 'logs')
const BENCHMARK_DIR = path.join(LOGS_DIR, 'benchmark')
const PIDS_DIR = path.join(LOGS_DIR, 'pids')
const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
const DIAGNOSIS_JOURNAL_PATH = path.join(LOGS_DIR, 'diagnosis-journal.md')
const PLAYWRIGHT_STDOUT_PATH = path.join(LOGS_DIR, 'playwright-stdout.log')
const HEAL_INDEX_PATH = path.join(LOGS_DIR, 'heal-index.md')
const FAILED_DIR = path.join(LOGS_DIR, 'failed')
fs.mkdirSync(FEATURES_DIR, { recursive: true })
fs.mkdirSync(PIDS_DIR, { recursive: true })

vi.mock('./paths', () => ({
  ROOT: PATH_ROOT,
  FEATURES_DIR,
  LOGS_DIR,
  BENCHMARK_DIR,
  PIDS_DIR,
  MANIFEST_PATH,
  SUMMARY_PATH,
  DIAGNOSIS_JOURNAL_PATH,
  PLAYWRIGHT_STDOUT_PATH,
  HEAL_INDEX_PATH,
  FAILED_DIR,
  RERUN_SIGNAL: path.join(LOGS_DIR, '.rerun'),
  RESTART_SIGNAL: path.join(LOGS_DIR, '.restart'),
  HEAL_SIGNAL: path.join(LOGS_DIR, '.heal'),
  SIGNAL_HISTORY_PATH: path.join(LOGS_DIR, 'signal-history.json'),
  ITERM_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-session-ids.json'),
  ITERM_HEAL_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-heal-session-ids.json'),
  getSummaryPath: () =>
    process.env.CANARY_LAB_SUMMARY_PATH ?? SUMMARY_PATH,
}))

const execFileSync = vi.fn()
const spawn = vi.fn()
vi.mock('child_process', () => ({ execFileSync, spawn }))

// readline is mocked so main()'s interactive prompts can be scripted.
const readlineAnswers: string[] = []
const rlMock = {
  question: (_q: string, cb: (answer: string) => void) => cb(readlineAnswers.shift() ?? '1'),
  close: vi.fn(),
}
vi.mock('readline', () => ({
  default: { createInterface: () => rlMock },
  createInterface: () => rlMock,
}))

// Silence iterm/terminal boundaries for any test that reaches them.
const openItermTabs = vi.fn(() => [] as string[])
const reuseItermTabs = vi.fn(() => false)
const closeItermSessionsByPrefix = vi.fn()
const closeItermSessionsByIds = vi.fn()
vi.mock('../launcher/iterm', () => ({
  openItermTabs,
  reuseItermTabs,
  closeItermSessionsByPrefix,
  closeItermSessionsByIds,
}))
const openTerminalTabs = vi.fn()
const closeTerminalTabsByPrefix = vi.fn()
vi.mock('../launcher/terminal', () => ({
  openTerminalTabs,
  closeTerminalTabsByPrefix,
}))

// Partial mock of startup — keep real normalizeStartCommand/resolvePath so the
// existing buildServiceList tests still exercise real logic; mock only isHealthy.
const isHealthy = vi.fn(async () => true)
vi.mock('../launcher/startup', async () => {
  const actual = await vi.importActual<typeof import('../launcher/startup')>(
    '../launcher/startup',
  )
  return { ...actual, isHealthy }
})

// auto-heal mocks for maybeAutoHeal tests.
const spawnHealAgent = vi.fn()
const closeLastHealAgentTab = vi.fn()
const isAgentCliAvailable = vi.fn(() => true)
const failureSignatureMock = vi.fn((failed: unknown) => {
  if (!Array.isArray(failed)) return ''
  return failed
    .map((e) => (typeof e === 'string' ? e : (e as { name?: string }).name ?? ''))
    .filter(Boolean)
    .sort()
    .join('|')
})
const buildStartupFailurePrompt = vi.fn(
  (args: {
    serviceName: string
    healthUrl: string
    logPath: string
    repoPath: string
    restartSignalPath: string
  }) =>
    `MOCK STARTUP PROMPT for ${args.serviceName} at ${args.healthUrl}`,
)
const checkUpgradeDrift = vi.fn(() => ({ installed: null, stamped: null, drift: false }))
const formatDriftNotice = vi.fn(() => null as string | null)
vi.mock('../runtime/upgrade-check', () => ({
  checkUpgradeDrift,
  formatDriftNotice,
}))

vi.mock('./auto-heal', () => ({
  spawnHealAgent,
  closeLastHealAgentTab,
  isAgentCliAvailable,
  failureSignature: failureSignatureMock,
  buildStartupFailurePrompt,
}))

const {
  buildServiceList,
  buildTeedCommand,
  truncateServiceLogs,
  portFromHealthUrl,
  parseFlags,
  readPid,
  lookupPidByPort,
  isProcessAlive,
  killProcessSync,
  killProcess,
  resolveRunningPid,
  writeManifest,
  discoverFeatures,
  printSummary,
  readFailureSignature,
  printManualOptions,
  safeReadFile,
  prompt,
  selectOption,
  checkRepos,
  loadSessionIds,
  saveSessionIds,
  openTabs,
  launchServices,
  pollHealthChecks,
  restartAllServices,
  restartServices,
  selectServicesToRestart,
  runPlaywright,
  maybeAutoHeal,
  AUTO_HEAL_MAX_CYCLES,
  itermSessionIds,
  watchMode,
  main,
  HealthCheckTimeoutError,
  handleHealthCheckFailure,
} = await import('./runner')
const { createBenchmarkTracker } = await import('./benchmark')
const { extractLogsForTest, enrichSummaryWithLogs } = await import('./log-enrichment')

beforeEach(() => {
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => '')
  spawn.mockReset()
  openItermTabs.mockReset()
  openItermTabs.mockReturnValue([])
  reuseItermTabs.mockReset()
  reuseItermTabs.mockReturnValue(false)
  closeItermSessionsByPrefix.mockReset()
  closeItermSessionsByIds.mockReset()
  openTerminalTabs.mockReset()
  closeTerminalTabsByPrefix.mockReset()
  isHealthy.mockReset()
  isHealthy.mockResolvedValue(true)
  spawnHealAgent.mockReset()
  closeLastHealAgentTab.mockReset()
  isAgentCliAvailable.mockReset()
  isAgentCliAvailable.mockReturnValue(true)
  itermSessionIds.clear()
  readlineAnswers.length = 0
})

const initialSigintListeners = process.listeners('SIGINT').slice()
const initialSigtermListeners = process.listeners('SIGTERM').slice()

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  // main() registers SIGINT/SIGTERM handlers; drop any added by tests so the
  // process listener count doesn't grow unbounded across the suite.
  for (const l of process.listeners('SIGINT')) {
    if (!initialSigintListeners.includes(l)) process.off('SIGINT', l as any)
  }
  for (const l of process.listeners('SIGTERM')) {
    if (!initialSigtermListeners.includes(l)) process.off('SIGTERM', l as any)
  }
  // Clear logs/features between tests (but keep dirs).
  for (const entry of fs.readdirSync(LOGS_DIR)) {
    fs.rmSync(path.join(LOGS_DIR, entry), { recursive: true, force: true })
  }
  fs.mkdirSync(PIDS_DIR, { recursive: true })
  for (const entry of fs.readdirSync(FEATURES_DIR)) {
    fs.rmSync(path.join(FEATURES_DIR, entry), { recursive: true, force: true })
  }
})

describe('buildServiceList', () => {
  it('produces empty list when no repos', () => {
    const feat: FeatureConfig = {
      name: 'f',
      description: '',
      envs: [],
      repos: [],
      featureDir: '',
    } as any
    expect(buildServiceList(feat)).toEqual([])
  })

  it('normalizes start commands and derives safeName + logPath', () => {
    const feat: FeatureConfig = {
      name: 'f',
      description: '',
      envs: [],
      repos: [
        {
          name: 'my-repo',
          localPath: '/tmp/repo',
          startCommands: [
            'npm run dev',
            {
              name: 'Worker Svc!',
              command: 'node worker.js',
              healthCheck: { url: 'http://localhost:4000/', timeoutMs: 1500 },
            },
          ],
        },
      ],
      featureDir: '',
    } as any

    const services = buildServiceList(feat)
    expect(services).toHaveLength(2)
    expect(services[0].name).toBe('my-repo-cmd-1')
    expect(services[0].safeName).toBe('my-repo-cmd-1')
    expect(services[0].command).toBe('npm run dev')
    expect(services[0].cwd).toBe('/tmp/repo')
    expect(services[1].name).toBe('Worker Svc!')
    expect(services[1].safeName).toBe('worker-svc-')
    expect(services[1].healthUrl).toBe('http://localhost:4000/')
    expect(services[1].healthTimeout).toBe(1500)
  })

  it('expands ~/ in repo localPath', () => {
    const feat: FeatureConfig = {
      name: 'f',
      description: '',
      envs: [],
      repos: [{ name: 'r', localPath: '~/code/r', startCommands: ['x'] }],
      featureDir: '',
    } as any
    const [svc] = buildServiceList(feat)
    expect(svc.cwd.startsWith('~/')).toBe(false)
  })
})

describe('buildTeedCommand', () => {
  it('wraps the command with LOG_MODE=plain and pipes to tee (canary default)', () => {
    const svc = {
      name: 's',
      safeName: 's',
      logPath: '/tmp/logs/svc-s.log',
      command: 'npm run dev',
      cwd: '/',
    } as any
    expect(buildTeedCommand(svc)).toBe(
      'LOG_MODE=plain npm run dev 2>&1 | tee -a /tmp/logs/svc-s.log',
    )
  })

  it('skips tee in baseline mode so no svc-*.log hits disk', () => {
    const svc = {
      name: 's',
      safeName: 's',
      logPath: '/tmp/logs/svc-s.log',
      command: 'npm run dev',
      cwd: '/',
    } as any
    expect(buildTeedCommand(svc, 'baseline')).toBe('LOG_MODE=plain npm run dev 2>&1')
  })
})

describe('truncateServiceLogs', () => {
  it('wipes existing log files to empty', () => {
    const dir = mkTmp()
    const a = path.join(dir, 'svc-a.log')
    const b = path.join(dir, 'svc-b.log')
    fs.writeFileSync(a, 'old a content\n<test-case-prev>...</test-case-prev>\n')
    fs.writeFileSync(b, 'old b content')

    truncateServiceLogs([
      { logPath: a } as any,
      { logPath: b } as any,
    ])

    expect(fs.readFileSync(a, 'utf-8')).toBe('')
    expect(fs.readFileSync(b, 'utf-8')).toBe('')
  })

  it('creates the file when it does not exist yet', () => {
    const dir = mkTmp()
    const p = path.join(dir, 'svc-fresh.log')
    expect(fs.existsSync(p)).toBe(false)

    truncateServiceLogs([{ logPath: p } as any])

    expect(fs.existsSync(p)).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('')
  })

  it('does not throw when log dir is missing (first run on a clean checkout)', () => {
    const missing = path.join(mkTmp(), 'nope', 'svc-x.log')
    expect(() => truncateServiceLogs([{ logPath: missing } as any])).not.toThrow()
  })

  it('is a no-op on empty service list', () => {
    expect(() => truncateServiceLogs([])).not.toThrow()
  })

  it('is a no-op in baseline mode even when files exist (no svc logs to wipe)', () => {
    const dir = mkTmp()
    const a = path.join(dir, 'svc-a.log')
    fs.writeFileSync(a, 'keep me')

    truncateServiceLogs([{ logPath: a } as any], 'baseline')

    expect(fs.readFileSync(a, 'utf-8')).toBe('keep me')
  })
})

describe('portFromHealthUrl', () => {
  it('extracts explicit port', () => {
    expect(portFromHealthUrl('http://localhost:3000/')).toBe(3000)
    expect(portFromHealthUrl('https://example.com:8443/health')).toBe(8443)
  })

  it('defaults to 80 for http and 443 for https when no port', () => {
    expect(portFromHealthUrl('http://example.com/')).toBe(80)
    expect(portFromHealthUrl('https://example.com/')).toBe(443)
  })

  it('returns null for malformed URLs', () => {
    expect(portFromHealthUrl('not a url')).toBeNull()
  })
})

describe('parseFlags', () => {
  it('returns defaults for empty args', () => {
    expect(parseFlags([])).toEqual({
      headed: false,
      terminal: 'iTerm',
      healSession: 'resume',
      benchmark: false,
      benchmarkMode: 'canary',
    })
  })

  it('parses --headed', () => {
    expect(parseFlags(['--headed']).headed).toBe(true)
  })

  it('parses --terminal space form and = form', () => {
    expect(parseFlags(['--terminal', 'Terminal']).terminal).toBe('Terminal')
    expect(parseFlags(['--terminal=Terminal']).terminal).toBe('Terminal')
  })

  it('rejects invalid --terminal values', () => {
    expect(() => parseFlags(['--terminal', 'kitty'])).toThrow(/--terminal/)
  })

  it('parses --heal-session both forms and validates', () => {
    expect(parseFlags(['--heal-session', 'new']).healSession).toBe('new')
    expect(parseFlags(['--heal-session=resume']).healSession).toBe('resume')
    expect(() => parseFlags(['--heal-session', 'maybe'])).toThrow(/--heal-session/)
  })

  it('parses benchmark flags in both split and equals forms', () => {
    expect(parseFlags(['--benchmark']).benchmark).toBe(true)
    expect(parseFlags(['--benchmark-mode', 'baseline']).benchmarkMode).toBe('baseline')
    expect(parseFlags(['--benchmark-mode=canary']).benchmarkMode).toBe('canary')
  })

  it('rejects invalid benchmark mode and removed benchmark flags', () => {
    expect(() => parseFlags(['--benchmark-mode', 'full'])).toThrow(/--benchmark-mode/)
    expect(() => parseFlags(['--benchmark-label', 'foo'])).toThrow(/Unknown flag/)
    expect(() => parseFlags(['--benchmark-max-cycles', '3'])).toThrow(/Unknown flag/)
  })

  it('throws on unknown flag', () => {
    expect(() => parseFlags(['--unknown'])).toThrow(/Unknown flag/)
  })
})

describe('readPid', () => {
  it('returns null when pid file missing', () => {
    expect(readPid('missing')).toBeNull()
  })

  it('returns parsed int from pid file, trimming whitespace', () => {
    fs.writeFileSync(path.join(PIDS_DIR, 'svc.pid'), '  12345  \n')
    expect(readPid('svc')).toBe(12345)
  })

  it('returns null when pid file contains non-numeric content', () => {
    fs.writeFileSync(path.join(PIDS_DIR, 'svc.pid'), 'not-a-pid')
    expect(readPid('svc')).toBeNull()
  })
})

describe('lookupPidByPort', () => {
  it('calls `lsof -ti tcp:<port> -sTCP:LISTEN` and parses first PID', () => {
    execFileSync.mockImplementation(() => '4242\n7777\n')
    expect(lookupPidByPort(3000)).toBe(4242)
    expect(execFileSync).toHaveBeenCalledWith(
      'lsof',
      ['-ti', 'tcp:3000', '-sTCP:LISTEN'],
      expect.objectContaining({ encoding: 'utf-8' }),
    )
  })

  it('returns null when lsof throws or returns no numeric PID', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('no port')
    })
    expect(lookupPidByPort(9999)).toBeNull()

    execFileSync.mockReset()
    execFileSync.mockImplementation(() => '\n')
    expect(lookupPidByPort(9999)).toBeNull()
  })
})

describe('isProcessAlive + killProcessSync + killProcess', () => {
  it('isProcessAlive returns true when process.kill(pid, 0) succeeds', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as any)
    expect(isProcessAlive(1234)).toBe(true)
    expect(spy).toHaveBeenCalledWith(1234, 0)
  })

  it('isProcessAlive returns false when process.kill throws', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    expect(isProcessAlive(9999)).toBe(false)
  })

  it('killProcessSync sends SIGTERM then SIGKILL', () => {
    const calls: Array<[number, NodeJS.Signals | number]> = []
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: any) => {
      calls.push([pid, sig])
      return true
    }) as any)
    killProcessSync(42)
    expect(calls).toEqual([
      [42, 'SIGTERM'],
      [42, 'SIGKILL'],
    ])
  })

  it('killProcessSync bails early if SIGTERM throws (process already dead)', () => {
    const calls: any[] = []
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: any) => {
      calls.push([pid, sig])
      throw new Error('ESRCH')
    }) as any)
    killProcessSync(42)
    expect(calls).toEqual([[42, 'SIGTERM']])
  })

  it('killProcess returns early when the initial SIGTERM throws (ESRCH)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    await expect(killProcess(9999)).resolves.toBeUndefined()
  })

  it('killProcess waits for graceful exit then SIGKILLs if still alive', async () => {
    vi.useFakeTimers()
    let alive = true
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: any) => {
      if (sig === 0) {
        if (!alive) throw new Error('ESRCH')
        return true
      }
      return true
    }) as any)
    const p = killProcess(77)
    await vi.advanceTimersByTimeAsync(5100)
    await p
    // SIGTERM (initial), plus many poll (0) signals, then SIGKILL
    const signals = spy.mock.calls.map((c) => c[1])
    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
  })
})

describe('resolveRunningPid', () => {
  const makeSvc = (over: any = {}) => ({
    name: 's',
    safeName: 's',
    logPath: '/x',
    command: 'c',
    cwd: '/',
    ...over,
  })

  it('returns pid from .pid file when that process is alive', () => {
    fs.writeFileSync(path.join(PIDS_DIR, 's.pid'), '100')
    vi.spyOn(process, 'kill').mockImplementation(() => true as any)
    expect(resolveRunningPid(makeSvc() as any)).toBe(100)
  })

  it('falls back to lsof when pid file dead and healthUrl is set', () => {
    fs.writeFileSync(path.join(PIDS_DIR, 's.pid'), '100')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 100) throw new Error('ESRCH')
      return true as any
    }) as any)
    execFileSync.mockImplementation(() => '555\n')
    expect(
      resolveRunningPid(
        makeSvc({ healthUrl: 'http://localhost:3000/' }) as any,
      ),
    ).toBe(555)
    void killSpy
  })

  it('returns null when healthUrl is malformed (portFromHealthUrl → null)', () => {
    fs.writeFileSync(path.join(PIDS_DIR, 's.pid'), '100')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    expect(
      resolveRunningPid(
        makeSvc({ healthUrl: 'not a url' }) as any,
      ),
    ).toBeNull()
  })

  it('returns null when both file pid and lsof pid are dead/absent', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    execFileSync.mockImplementation(() => '')
    expect(
      resolveRunningPid(
        makeSvc({ healthUrl: 'http://localhost:3000/' }) as any,
      ),
    ).toBeNull()
  })

  it('returns null when no pid file and no healthUrl', () => {
    expect(resolveRunningPid(makeSvc() as any)).toBeNull()
  })
})

describe('writeManifest', () => {
  it('writes serviceLogs JSON with a trailing newline', () => {
    writeManifest([
      { safeName: 'a', logPath: '/x/a.log' } as any,
      { safeName: 'b', logPath: '/x/b.log' } as any,
    ])
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ serviceLogs: ['/x/a.log', '/x/b.log'] })
  })

  it('includes featureName + featureDir + existing repoPaths when a feature is provided', () => {
    const repoExists = mkTmp()
    const feature: FeatureConfig = {
      name: 'f',
      description: 'd',
      envs: [],
      featureDir: '/feat/dir',
      repos: [
        { name: 'a', localPath: repoExists, startCommands: ['x'] },
        { name: 'b', localPath: '/does/not/exist/xyz', startCommands: ['y'] },
      ],
    } as any

    writeManifest(
      [{ safeName: 'a', logPath: '/x/a.log' } as any],
      feature,
    )

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
    expect(manifest.featureName).toBe('f')
    expect(manifest.featureDir).toBe('/feat/dir')
    // Non-existent repoPath is filtered out.
    expect(manifest.repoPaths).toEqual([repoExists])
  })
})

describe('discoverFeatures', () => {
  it('loads feature.config.cjs modules and prefers named `config` export', () => {
    const featDir = path.join(FEATURES_DIR, 'alpha')
    fs.mkdirSync(featDir)
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'alpha', description: 'd', envs: [], repos: [] } }`,
    )
    const features = discoverFeatures()
    expect(features.map((f) => f.name)).toEqual(['alpha'])
  })

  it('skips dirs without any feature config file', () => {
    fs.mkdirSync(path.join(FEATURES_DIR, 'empty'))
    expect(discoverFeatures()).toEqual([])
  })

  it('skips malformed config (throws during require)', () => {
    const featDir = path.join(FEATURES_DIR, 'broken')
    fs.mkdirSync(featDir)
    fs.writeFileSync(path.join(featDir, 'feature.config.cjs'), 'throw new Error("boom")')
    expect(discoverFeatures()).toEqual([])
  })
})

describe('extractLogsForTest', () => {
  it('returns snippets between <slug> and </slug> tags per log file', () => {
    const dir = mkTmp()
    const a = path.join(dir, 'svc-a.log')
    fs.writeFileSync(a, 'before\n<test-case-foo>\nhello a\n</test-case-foo>\nafter\n')
    const b = path.join(dir, 'svc-b.log')
    fs.writeFileSync(b, 'no markers here')
    expect(extractLogsForTest('test-case-foo', [a, b])).toEqual({
      'svc-a': 'hello a',
    })
  })

  it('ignores missing files and empty snippets', () => {
    const dir = mkTmp()
    const a = path.join(dir, 'svc-a.log')
    fs.writeFileSync(a, '<test-case-x></test-case-x>')
    expect(
      extractLogsForTest('test-case-x', [a, path.join(dir, 'missing.log')]),
    ).toEqual({})
  })

  it('caps large snippets to head + tail with an elision marker', async () => {
    const { SLICE_HALF_BYTES } = await import('./log-enrichment')
    const dir = mkTmp()
    const logPath = path.join(dir, 'svc-big.log')
    const headBody = 'HEAD'.repeat(SLICE_HALF_BYTES / 4 + 500)
    const tailBody = 'TAIL'.repeat(SLICE_HALF_BYTES / 4 + 500)
    fs.writeFileSync(logPath, `<test-case-huge>${headBody}${tailBody}</test-case-huge>`)
    const sliced = extractLogsForTest('test-case-huge', [logPath])['svc-big']
    expect(sliced).toBeDefined()
    expect(sliced.startsWith('HEAD')).toBe(true)
    expect(sliced.endsWith('TAIL')).toBe(true)
    expect(sliced).toContain('eliding')
    expect(Buffer.byteLength(sliced, 'utf-8')).toBeLessThan(SLICE_HALF_BYTES * 2 + 500)
  })
})

describe('enrichSummaryWithLogs', () => {
  it('writes per-failure slice files and attaches logFiles paths (not embedded logs)', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [{ name: 'test-case-bad', error: { message: 'boom' } }],
      }),
    )
    const logPath = path.join(LOGS_DIR, 'svc-x.log')
    fs.writeFileSync(logPath, '<test-case-bad>\nlog body\n</test-case-bad>')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [logPath] }))

    enrichSummaryWithLogs()

    const out = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
    // Summary stays lean — no embedded log bodies.
    expect(out.failed[0].logs).toBeUndefined()
    expect(out.failed[0].error).toEqual({ message: 'boom' })
    expect(out.failed[0].logFiles).toEqual(['logs/failed/test-case-bad/svc-x.log'])

    // Per-failure slice file exists with the extracted snippet.
    const slicePath = path.join(FAILED_DIR, 'test-case-bad', 'svc-x.log')
    expect(fs.existsSync(slicePath)).toBe(true)
    expect(fs.readFileSync(slicePath, 'utf-8')).toBe('log body')
  })

  it('does not attach logFiles when no slices were captured', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [{ name: 'test-case-quiet' }],
      }),
    )
    const logPath = path.join(LOGS_DIR, 'svc-silent.log')
    fs.writeFileSync(logPath, 'no markers for this test')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [logPath] }))

    enrichSummaryWithLogs()

    const out = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
    expect(out.failed[0].logFiles).toBeUndefined()
    expect(out.failed[0].logs).toBeUndefined()
  })

  it('no-ops when summary or manifest missing', () => {
    enrichSummaryWithLogs()
    expect(fs.existsSync(SUMMARY_PATH)).toBe(false)
  })

  it('no-ops when summary has no failures', () => {
    const body = JSON.stringify({ total: 1, passed: 1, failed: [] })
    fs.writeFileSync(SUMMARY_PATH, body)
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    enrichSummaryWithLogs()
    expect(fs.readFileSync(SUMMARY_PATH, 'utf-8')).toBe(body)
  })
})

describe('writeHealIndex', () => {
  it('writes a flat map: feature + repos + failures with exact slice paths + one-line journal', async () => {
    const { writeHealIndex } = await import('./log-enrichment')

    const repo = mkTmp()
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({
        serviceLogs: [],
        featureName: 'mpass',
        featureDir: path.join(PATH_ROOT, 'features', 'mpass'),
        repoPaths: [repo],
      }),
    )
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 2,
        passed: 1,
        failed: [
          {
            name: 'test-case-oauth-metadata',
            error: { message: 'expected refresh_token to be advertised' },
            location: 'features/mpass/e2e/x.spec.ts:42',
            logFiles: ['logs/failed/test-case-oauth-metadata/svc-a.log'],
          },
        ],
      }),
    )
    fs.writeFileSync(
      DIAGNOSIS_JOURNAL_PATH,
      [
        '# Diagnosis Journal',
        '',
        '## Iteration 1 — 2026-04-22T00:00:00Z',
        '',
        '- hypothesis: missing field',
        '- fix.file: a.java',
        '- fix.description: added field',
        '- outcome: no_change',
        '',
        '## Iteration 2 — 2026-04-22T00:10:00Z',
        '',
        '- hypothesis: try PKCE check',
        '- outcome: pending',
        '',
      ].join('\n'),
    )

    writeHealIndex()

    const md = fs.readFileSync(HEAL_INDEX_PATH, 'utf-8')

    // Map header — feature dir, repo paths. No status / timestamp.
    expect(md).toContain('# Heal Index')
    expect(md).toContain('Feature:')
    expect(md).toContain('Repos:')
    expect(md).toContain(repo)
    expect(md).not.toContain('Status:')

    // Flat failure shape.
    expect(md).toContain('## Failures')
    expect(md).not.toContain('## Failures —')
    expect(md).not.toContain('### Cluster')
    expect(md).toContain('- **test-case-oauth-metadata**')
    expect(md).toContain('expected refresh_token to be advertised')
    expect(md).toContain('slice: logs/failed/test-case-oauth-metadata/svc-a.log')

    // Test-location pointer is NOT in the index.
    expect(md).not.toContain('features/mpass/e2e/x.spec.ts:42')

    // Journal condensed to a single line.
    expect(md).toContain('Journal:')
    expect(md).toContain('#1')
    expect(md).toContain('no_change')
    expect(md).toContain('pending')
    expect(md).not.toContain('## Journal')

    // Removed from earlier drafts / format iterations.
    expect(md).not.toContain('suspects')
    expect(md).not.toContain('## failed[0]')
    expect(md).not.toContain('```ts')
    expect(md).not.toMatch(/\d+(\.\d+)?KB/)
    expect(md).not.toContain('target service:')
    expect(md).not.toContain('target services (in every slice):')
    expect(md).not.toContain('source:')
    expect(md).not.toContain('likely handler:')
    expect(md).not.toContain('slice services:')

    // Keep it tight.
    expect(Buffer.byteLength(md, 'utf-8')).toBeLessThan(2_000)
  })

  it('strips ANSI escape codes from error messages', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        failed: [
          {
            name: 'test-case-ansi',
            // Both escape forms: the real ESC prefix and the bracketed-only
            // form Playwright writes in some reporter modes.
            error: {
              message:
                'Error: \x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m\x1b[2m).toBe(\x1b[22m\x1b[32mexpected\x1b[39m\x1b[2m)\x1b[22m ' +
                'Expected: [32m400[39m Received: [31m200[39m',
            },
            logFiles: ['logs/failed/test-case-ansi/svc-api.log'],
          },
        ],
      }),
    )

    writeHealIndex()
    const md = fs.readFileSync(HEAL_INDEX_PATH, 'utf-8')

    expect(md).toContain('Error: expect(received).toBe(expected) Expected: 400 Received: 200')
    // No raw ANSI leaked.
    expect(md).not.toMatch(/\x1b\[/)
    expect(md).not.toMatch(/\[\d+m/)
  })

  it('renders one bullet per failed entry without retry dedupe', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        failed: [
          {
            name: 'test-case-pkce-claude',
            error: { message: 'Expected: 400 Received: 200' },
            retry: 0,
            logFiles: ['logs/failed/test-case-pkce-claude/svc-api.log'],
          },
          {
            name: 'test-case-pkce-claude',
            error: { message: 'Expected: 400 Received: 200' },
            retry: 1,
            logFiles: ['logs/failed/test-case-pkce-claude/svc-api.log'],
          },
          {
            name: 'test-case-pkce-cursor',
            error: { message: 'Expected: 400 Received: 200' },
            retry: 0,
            logFiles: ['logs/failed/test-case-pkce-cursor/svc-api.log'],
          },
          {
            name: 'test-case-introspect',
            error: { message: 'Expected active:false Received active:true' },
            retry: 0,
            logFiles: ['logs/failed/test-case-introspect/svc-api.log'],
          },
        ],
      }),
    )

    writeHealIndex()
    const md = fs.readFileSync(HEAL_INDEX_PATH, 'utf-8')

    expect(md).not.toContain('(×2)')
    expect((md.match(/- \*\*test-case-pkce-claude\*\*/g) ?? []).length).toBe(2)
    expect(md).toContain('slice: logs/failed/test-case-pkce-claude/svc-api.log')
    expect(md).toMatch(/- \*\*test-case-pkce-cursor\*\*/)
    expect(md).toContain('slice: logs/failed/test-case-pkce-cursor/svc-api.log')
    expect(md).toContain('- **test-case-introspect**')
    expect(md).toContain('Expected active:false Received active:true')
    expect(md).not.toContain('### Cluster')
    expect(md).not.toContain('target service:')
    expect(md).not.toContain('slice services:')
  })

  it('does not render inferred target, source, handler, or service-frequency hints', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    const repo = mkTmp()
    const repoBase = path.basename(repo)
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        failed: [
          {
            name: 'test-case-a',
            error: { message: 'same error' },
            logFiles: [
              `logs/failed/test-case-a/svc-${repoBase}-oddle-service.log`,
              'logs/failed/test-case-a/svc-super-admin-portal.log',
            ],
          },
          {
            name: 'test-case-b',
            error: { message: 'same error' },
            logFiles: ['logs/failed/test-case-b/svc-super-admin-portal.log'],
          },
          {
            name: 'test-case-c',
            error: { message: 'other error' },
            logFiles: ['logs/failed/test-case-c/svc-super-admin-portal.log'],
          },
        ],
      }),
    )

    writeHealIndex()
    const md = fs.readFileSync(HEAL_INDEX_PATH, 'utf-8')

    expect(md).toContain(`slice: logs/failed/test-case-a/svc-${repoBase}-oddle-service.log, logs/failed/test-case-a/svc-super-admin-portal.log`)
    expect(md).toContain('slice: logs/failed/test-case-b/svc-super-admin-portal.log')
    expect(md).not.toContain('target service:')
    expect(md).not.toContain('target services (in every slice):')
    expect(md).not.toContain('source:')
    expect(md).not.toContain('likely handler:')
    expect(md).not.toContain('slice services:')
  })

  it('never spawns grep subprocesses', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    const repo = mkTmp()
    fs.writeFileSync(path.join(repo, 'app.ts'), 'dummy')
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ serviceLogs: [], repoPaths: [repo] }),
    )
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-metadata',
            error: { message: 'expected grant_types_supported to contain "refresh_token"' },
            location: 'features/x/e2e/y.spec.ts:1',
          },
        ],
      }),
    )

    const grepCallsBefore = execFileSync.mock.calls.filter((c) => c[0] === 'grep').length
    writeHealIndex()
    const grepCallsAfter = execFileSync.mock.calls.filter((c) => c[0] === 'grep').length
    expect(grepCallsAfter - grepCallsBefore).toBe(0)
  })

  it('no-ops when no summary exists', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    writeHealIndex()
    expect(fs.existsSync(HEAL_INDEX_PATH)).toBe(false)
  })

  it('says "nothing to heal" when no failures', async () => {
    const { writeHealIndex } = await import('./log-enrichment')
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ total: 5, passed: 5, failed: [] }),
    )
    writeHealIndex()
    const md = fs.readFileSync(HEAL_INDEX_PATH, 'utf-8')
    expect(md).toContain('No failures. Nothing to heal.')
  })
})

describe('appendJournalIteration', () => {
  beforeEach(() => {
    try { fs.unlinkSync(DIAGNOSIS_JOURNAL_PATH) } catch { /* ignore */ }
  })

  it('writes iteration 1 with feature, failingTests, hypothesis, fix.file', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ serviceLogs: [], featureName: 'mpass_oauth' }),
    )
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 2,
        passed: 1,
        failed: [{ name: 'test-case-oauth-metadata' }],
      }),
    )

    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'grant_types_supported missing refresh_token',
      filesChanged: ['/abs/path/OAuthServiceImpl.java'],
    })

    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(md).toContain('# Diagnosis Journal')
    expect(md).toContain('## Iteration 1')
    expect(md).toContain('- feature: mpass_oauth')
    expect(md).toContain('- failingTests: test-case-oauth-metadata')
    expect(md).toContain('- hypothesis: grant_types_supported missing refresh_token')
    expect(md).toContain('- fix.file: /abs/path/OAuthServiceImpl.java')
    expect(md).toContain('- signal: .restart')
    expect(md).toContain('- outcome: pending')
  })

  it('increments iteration number on subsequent calls', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )
    appendJournalIteration({ signal: '.restart', hypothesis: 'h1' })
    appendJournalIteration({ signal: '.rerun', hypothesis: 'h2' })

    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(md).toMatch(/## Iteration 1 —/)
    expect(md).toMatch(/## Iteration 2 —/)
    // First header is only written on first append.
    expect(md.match(/# Diagnosis Journal/g) ?? []).toHaveLength(1)
  })

  it('skips when hypothesis is empty', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    appendJournalIteration({ signal: '.restart' })
    expect(fs.existsSync(DIAGNOSIS_JOURNAL_PATH)).toBe(false)
  })

  it('skips when hypothesis is only whitespace', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    appendJournalIteration({ signal: '.restart', hypothesis: '   \n  ' })
    expect(fs.existsSync(DIAGNOSIS_JOURNAL_PATH)).toBe(false)
  })

  it('joins multiple filesChanged with commas and includes fixDescription', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'x' }] }))
    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'h',
      filesChanged: ['/a/File1.java', '/b/File2.java'],
      fixDescription: 'added refresh_token to the advertised grant types',
    })
    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(md).toContain('- fix.file: /a/File1.java, /b/File2.java')
    expect(md).toContain('- fix.description: added refresh_token to the advertised grant types')
  })

  it('omits feature line when manifest has no featureName, and failingTests when summary missing', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    try { fs.unlinkSync(MANIFEST_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(SUMMARY_PATH) } catch { /* ignore */ }
    appendJournalIteration({ signal: '.rerun', hypothesis: 'no-context' })
    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(md).toContain('- hypothesis: no-context')
    expect(md).toContain('- signal: .rerun')
    expect(md).not.toContain('- feature:')
    expect(md).not.toContain('- failingTests:')
  })

  it('picks up existing iteration numbers and appends N+1', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'x' }] }))
    fs.writeFileSync(
      DIAGNOSIS_JOURNAL_PATH,
      [
        '# Diagnosis Journal',
        '',
        '## Iteration 1 — 2026-04-22T00:00:00Z',
        '- hypothesis: old1',
        '- outcome: no_change',
        '',
        '## Iteration 7 — 2026-04-22T01:00:00Z',
        '- hypothesis: old7',
        '- outcome: pending',
        '',
      ].join('\n'),
    )
    appendJournalIteration({ signal: '.restart', hypothesis: 'new' })
    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(md).toMatch(/## Iteration 8 —/)
    // Does not re-add the top-level header — file already had one.
    expect(md.match(/# Diagnosis Journal/g) ?? []).toHaveLength(1)
  })

  it('truncates an excessively long hypothesis', async () => {
    const { appendJournalIteration } = await import('./log-enrichment')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [] }))
    const long = 'x'.repeat(1_000)
    appendJournalIteration({ signal: '.restart', hypothesis: long })
    const md = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    const line = md.split('\n').find((l) => l.startsWith('- hypothesis:')) ?? ''
    // Field + 400 cap + ellipsis — never the full 1000 chars.
    expect(line.length).toBeLessThan(500)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('buildHealAddendum', () => {
  beforeEach(() => {
    try { fs.unlinkSync(DIAGNOSIS_JOURNAL_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(SUMMARY_PATH) } catch { /* ignore */ }
  })

  it('on cycle 1 with no journal, omits journal/outcome guidance', async () => {
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ failed: [{ name: 'test-foo' }] }),
    )
    const out = buildHealAddendum({ cycle: 1 })
    expect(out).toContain('Cycle 1')
    expect(out).toContain('Failing tests: test-foo')
    expect(out).toContain('Do NOT Read the test spec')
    expect(out).not.toContain('grep the distinctive literal')
    expect(out).not.toContain('one grouped edit')
    expect(out).toContain('runner appends an iteration entry automatically')
    expect(out).not.toContain('outcome')
    expect(out).not.toContain('Skip hypotheses already tried')
  })

  it('on cycle 2 with journal present, includes outcome + skip-prior guidance', async () => {
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ failed: [{ name: 'test-foo' }] }),
    )
    fs.writeFileSync(
      DIAGNOSIS_JOURNAL_PATH,
      '# Diagnosis Journal\n\n## Iteration 1 — 2026-04-22\n\n- hypothesis: x\n- outcome: pending\n',
    )
    const out = buildHealAddendum({ cycle: 2 })
    expect(out).toContain('Cycle 2')
    expect(out).toContain('outcome: pending')
    expect(out).toContain('Skip hypotheses already tried')
  })

  it('on cycle 1 WITH journal present, still omits journal guidance', async () => {
    // Journal can exist if a prior run succeeded then a new failure appeared.
    // Cycle 1 means no prior iteration in THIS failure cluster — don't ask
    // the agent to update an outcome that doesn't apply to it.
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [] }))
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, '# Diagnosis Journal\n\n## Iteration 1 — x\n- hypothesis: y\n- outcome: all_passed\n')
    const out = buildHealAddendum({ cycle: 1 })
    expect(out).not.toContain('Skip hypotheses already tried')
    expect(out).not.toContain('outcome: pending')
  })

  it('on cycle 2 WITHOUT a journal, omits outcome guidance', async () => {
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    const out = buildHealAddendum({ cycle: 2 })
    expect(out).toContain('Cycle 2')
    expect(out).not.toContain('Skip hypotheses already tried')
  })

  it('omits the "Failing tests:" suffix when no summary exists', async () => {
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    const out = buildHealAddendum({ cycle: 1 })
    expect(out).toContain('Cycle 1')
    expect(out).not.toContain('Failing tests:')
    // Core guidance is still present — no summary shouldn't strip the rules.
    expect(out).toContain('Do NOT Read the test spec')
    expect(out).toContain('runner appends an iteration entry automatically')
  })

  it('includes maxCycles suffix when provided', async () => {
    const { buildHealAddendum } = await import('./heal-prompt-builder')
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [] }))
    const out = buildHealAddendum({ cycle: 1, maxCycles: 3 })
    expect(out).toContain('Cycle 1 of 3')
  })
})

describe('printSummary / printManualOptions', () => {
  it('printSummary notes missing summary file', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printSummary()
    expect(logSpy.mock.calls.flat().join('\n')).toContain('No summary file found')
  })

  it('printSummary lists failures', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 2,
        passed: 1,
        failed: [{ name: 'test-case-a' }, 'test-case-b'],
      }),
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printSummary()
    const joined = logSpy.mock.calls.flat().join('\n')
    expect(joined).toMatch(/Total:?\s+2/)
    expect(joined).toMatch(/Passed:?\s+1/)
    expect(joined).toMatch(/Failed:?\s+2/)
    expect(joined).toContain('test-case-a')
    expect(joined).toContain('test-case-b')
  })

  it('printManualOptions varies with autoHealConfigured', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printManualOptions(true)
    const withHeal = logSpy.mock.calls.flat().join('\n')
    expect(withHeal).toContain('touch logs/.heal')
    logSpy.mockClear()
    printManualOptions(false)
    const withoutHeal = logSpy.mock.calls.flat().join('\n')
    expect(withoutHeal).not.toContain('touch logs/.heal')
    expect(withoutHeal).toContain('touch logs/.rerun')
  })
})

describe('readFailureSignature', () => {
  it('returns empty string when summary missing', () => {
    expect(readFailureSignature()).toBe('')
  })

  it('returns sorted signature for failed array', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ failed: [{ name: 'b' }, { name: 'a' }] }),
    )
    expect(readFailureSignature()).toBe('a|b')
  })

  it('returns empty when JSON is malformed', () => {
    fs.writeFileSync(SUMMARY_PATH, 'not-json')
    expect(readFailureSignature()).toBe('')
  })
})

describe('safeReadFile', () => {
  it('returns file contents when readable', () => {
    const dir = mkTmp()
    const p = path.join(dir, 'x.txt')
    fs.writeFileSync(p, 'hello')
    expect(safeReadFile(p)).toBe('hello')
  })

  it('returns null when file does not exist', () => {
    expect(safeReadFile('/tmp/__does_not_exist__.xyz')).toBeNull()
  })
})

describe('prompt', () => {
  it('resolves with the answer passed to rl.question', async () => {
    const rl = {
      question: (_q: string, cb: (a: string) => void) => cb('answer'),
    } as any
    await expect(prompt(rl, 'Q: ')).resolves.toBe('answer')
  })
})

describe('selectOption', () => {
  it('returns the chosen option on valid input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const answers = ['2']
    const rl = {
      question: (_q: string, cb: (a: string) => void) => cb(answers.shift()!),
    } as any
    const result = await selectOption(rl, 'pick', ['a', 'b', 'c'])
    expect(result).toBe('b')
  })

  it('re-prompts on out-of-range input, then accepts valid input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const answers = ['9', '0', 'abc', '1']
    const rl = {
      question: (_q: string, cb: (a: string) => void) => cb(answers.shift()!),
    } as any
    const result = await selectOption(rl, 'pick', ['x', 'y'])
    expect(result).toBe('x')
    expect(answers).toEqual([])
  })
})

describe('checkRepos', () => {
  it('returns true when feature has no repos', () => {
    expect(checkRepos({ name: 'f', repos: [] } as any)).toBe(true)
    expect(checkRepos({ name: 'f' } as any)).toBe(true)
  })

  it('returns true when all repos exist', () => {
    const dir = mkTmp()
    const repoDir = path.join(dir, 'repo')
    fs.mkdirSync(repoDir)
    const feat = {
      repos: [{ name: 'r', localPath: repoDir, startCommands: [] }],
    } as any
    expect(checkRepos(feat)).toBe(true)
  })

  it('returns false when a repo is missing and logs clone hint', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const feat = {
      repos: [
        {
          name: 'missing-repo',
          localPath: '/definitely/does/not/exist',
          startCommands: [],
          cloneUrl: 'git@github.com:org/missing-repo.git',
        },
      ],
    } as any
    expect(checkRepos(feat)).toBe(false)
    const joined = errSpy.mock.calls.flat().join('\n')
    expect(joined).toContain('Missing repo: missing-repo')
    expect(joined).toContain('git clone git@github.com:org/missing-repo.git')
  })

  it('omits clone instructions when repo has no cloneUrl', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const feat = {
      repos: [{ name: 'r', localPath: '/nope', startCommands: [] }],
    } as any
    expect(checkRepos(feat)).toBe(false)
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain('git clone')
  })
})

describe('loadSessionIds / saveSessionIds', () => {
  it('round-trips a Map via JSON', () => {
    const file = path.join(mkTmp(), 'ids.json')
    const m = new Map([['a', 'A1'], ['b', 'B1']])
    saveSessionIds(file, m)
    const loaded = loadSessionIds(file)
    expect(Array.from(loaded.entries()).sort()).toEqual([
      ['a', 'A1'],
      ['b', 'B1'],
    ])
  })

  it('returns an empty Map for missing or malformed files', () => {
    expect(loadSessionIds('/tmp/__missing__ids.json').size).toBe(0)
    const file = path.join(mkTmp(), 'ids.json')
    fs.writeFileSync(file, 'not-json')
    expect(loadSessionIds(file).size).toBe(0)
  })

  it('saveSessionIds is non-fatal when mkdir/write fails', () => {
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      saveSessionIds('/tmp/cl-noperms/ids.json', new Map([['a', 'A']])),
    ).not.toThrow()
    spy.mockRestore()
  })
})

describe('openTabs', () => {
  it('Terminal branch closes by prefix and opens fresh tabs', () => {
    const tabs = [{ dir: '/', command: 'echo 1', name: 'svc' }]
    openTabs('Terminal', tabs, 'label')
    expect(closeTerminalTabsByPrefix).toHaveBeenCalledWith(['svc'])
    expect(openTerminalTabs).toHaveBeenCalledWith(tabs, 'label')
    expect(openItermTabs).not.toHaveBeenCalled()
  })

  it('iTerm fresh run closes by prefix and opens, persisting ids', () => {
    openItermTabs.mockReturnValueOnce(['SID-A', 'SID-B'])
    const tabs = [
      { dir: '/', command: 'a', name: 'svc-a' },
      { dir: '/', command: 'b', name: 'svc-b' },
    ]
    openTabs('iTerm', tabs, 'label')
    expect(reuseItermTabs).not.toHaveBeenCalled() // map empty → skipped
    expect(closeItermSessionsByIds).not.toHaveBeenCalled() // no known ids yet
    expect(closeItermSessionsByPrefix).toHaveBeenCalledWith(['svc-a', 'svc-b'])
    expect(openItermTabs).toHaveBeenCalledWith(tabs, 'label')
    expect(itermSessionIds.get('svc-a')).toBe('SID-A')
    expect(itermSessionIds.get('svc-b')).toBe('SID-B')
  })

  it('iTerm reuses tabs when all names have cached ids and reuse succeeds', () => {
    itermSessionIds.set('svc-a', 'SID-A')
    reuseItermTabs.mockReturnValueOnce(true)
    const tabs = [{ dir: '/', command: 'a', name: 'svc-a' }]
    openTabs('iTerm', tabs, 'label')
    expect(reuseItermTabs).toHaveBeenCalledWith(['SID-A'], tabs, 'label')
    expect(openItermTabs).not.toHaveBeenCalled()
    expect(closeItermSessionsByIds).not.toHaveBeenCalled()
  })

  it('iTerm falls back to close+open when reuse returns false', () => {
    itermSessionIds.set('svc-a', 'OLD-A')
    reuseItermTabs.mockReturnValueOnce(false)
    openItermTabs.mockReturnValueOnce(['NEW-A'])
    const tabs = [{ dir: '/', command: 'a', name: 'svc-a' }]
    openTabs('iTerm', tabs, 'label')
    expect(closeItermSessionsByIds).toHaveBeenCalledWith(['OLD-A'])
    expect(closeItermSessionsByPrefix).toHaveBeenCalledWith(['svc-a'])
    expect(openItermTabs).toHaveBeenCalledWith(tabs, 'label')
    expect(itermSessionIds.get('svc-a')).toBe('NEW-A')
  })
})

describe('launchServices', () => {
  it('is a no-op when service list is empty', async () => {
    await launchServices([], 'iTerm')
    expect(openItermTabs).not.toHaveBeenCalled()
    expect(openTerminalTabs).not.toHaveBeenCalled()
  })

  it('kills existing processes, truncates logs, and opens tabs', async () => {
    vi.useFakeTimers()
    // A pid file exists and corresponds to an alive process.
    fs.writeFileSync(path.join(PIDS_DIR, 'svc-a.pid'), '555')
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(((_: number, sig: any) => {
        if (sig === 0) return true // always "alive" for the isProcessAlive check
        return true
      }) as any)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const dir = mkTmp()
    const logPath = path.join(dir, 'svc-a.log')
    fs.writeFileSync(logPath, 'pre-existing content')
    const svc = {
      name: 'svc-a',
      safeName: 'svc-a',
      logPath,
      command: 'node a',
      cwd: '/',
    } as any
    openItermTabs.mockReturnValueOnce(['SID-A'])

    const p = launchServices([svc], 'iTerm')
    // Drive the 5s graceful-kill wait.
    await vi.advanceTimersByTimeAsync(5500)
    await p

    expect(killSpy).toHaveBeenCalledWith(555, 'SIGTERM')
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('')
    expect(openItermTabs).toHaveBeenCalledOnce()
  })
})

describe('pollHealthChecks', () => {
  it('resolves immediately when no service has a healthUrl', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(
      pollHealthChecks([{ name: 'x', safeName: 'x', logPath: '/', command: '', cwd: '/' } as any]),
    ).resolves.toBeUndefined()
    expect(isHealthy).not.toHaveBeenCalled()
  })

  it('resolves when all services become healthy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    isHealthy.mockResolvedValue(true)
    await pollHealthChecks([
      {
        name: 's',
        safeName: 's',
        logPath: '/',
        command: '',
        cwd: '/',
        healthUrl: 'http://localhost:3000/',
      } as any,
    ])
    expect(isHealthy).toHaveBeenCalled()
  })

  it('throws a timeout error when a service stays unhealthy past the deadline', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    isHealthy.mockResolvedValue(false)
    await expect(
      pollHealthChecks(
        [
          {
            name: 's',
            safeName: 's',
            logPath: '/',
            command: '',
            cwd: '/',
            healthUrl: 'http://localhost:3000/',
          } as any,
        ],
        10, // 10 ms deadline — shorter than the 2000 ms poll sleep
      ),
    ).rejects.toThrow(/Health check timed out for s/)
  })
})

describe('selectServicesToRestart', () => {
  const makeSvc = (over: Partial<{ name: string; cwd: string }> = {}) =>
    ({
      name: over.name ?? 's',
      safeName: over.name ?? 's',
      logPath: '/tmp/s.log',
      command: 'x',
      cwd: over.cwd ?? '/repos/api',
    } as any)

  it('returns null when filesChanged is missing, empty, or non-array', () => {
    const svcs = [makeSvc()]
    expect(selectServicesToRestart(svcs, undefined)).toBeNull()
    expect(selectServicesToRestart(svcs, null)).toBeNull()
    expect(selectServicesToRestart(svcs, [])).toBeNull()
    expect(selectServicesToRestart(svcs, 'string')).toBeNull()
    expect(selectServicesToRestart(svcs, { a: 1 })).toBeNull()
  })

  it('returns only the service whose repo matched an absolute path', () => {
    const apiRepo = mkTmp()
    const webRepo = mkTmp()
    const api = makeSvc({ name: 'api', cwd: apiRepo })
    const web = makeSvc({ name: 'web', cwd: webRepo })
    const result = selectServicesToRestart(
      [api, web],
      [path.join(apiRepo, 'src', 'index.ts')],
    )
    expect(result?.map((s) => s.name)).toEqual(['api'])
  })

  it('groups all services sharing a repo (multi-startCommand repo restarts together)', () => {
    const repo = mkTmp()
    const webSrv = makeSvc({ name: 'web', cwd: repo })
    const worker = makeSvc({ name: 'worker', cwd: repo })
    const result = selectServicesToRestart(
      [webSrv, worker],
      [path.join(repo, 'pkg', 'a.ts')],
    )
    expect(result?.map((s) => s.name).sort()).toEqual(['web', 'worker'])
  })

  it('returns services from multiple repos when files span both', () => {
    const a = mkTmp()
    const b = mkTmp()
    const svcA = makeSvc({ name: 'a', cwd: a })
    const svcB = makeSvc({ name: 'b', cwd: b })
    const result = selectServicesToRestart(
      [svcA, svcB],
      [path.join(a, 'x.ts'), path.join(b, 'y.ts')],
    )
    expect(result?.map((s) => s.name).sort()).toEqual(['a', 'b'])
  })

  it('warns and returns null when any path is outside every repo', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const repo = mkTmp()
    const svc = makeSvc({ name: 'api', cwd: repo })
    const result = selectServicesToRestart(
      [svc],
      [path.join(repo, 'src', 'a.ts'), '/tmp/__elsewhere__/x.ts'],
    )
    expect(result).toBeNull()
    void warnSpy
    void logSpy
    void writeSpy
  })

  it('resolves relative paths against ROOT', () => {
    const repoDir = path.join(PATH_ROOT, 'my-repo')
    fs.mkdirSync(repoDir, { recursive: true })
    const svc = makeSvc({ name: 'api', cwd: repoDir })
    const result = selectServicesToRestart([svc], ['my-repo/src/a.ts'])
    expect(result?.map((s) => s.name)).toEqual(['api'])
  })

  it('expands ~/... paths via resolvePath', () => {
    const home = os.homedir()
    const repoDir = path.join(home, '.canary-lab-test-fake-repo')
    const svc = makeSvc({ name: 'api', cwd: repoDir })
    const result = selectServicesToRestart(
      [svc],
      ['~/.canary-lab-test-fake-repo/src/a.ts'],
    )
    expect(result?.map((s) => s.name)).toEqual(['api'])
  })

  it('prefers the deepest repo when one repo is nested inside another', () => {
    const outer = mkTmp()
    const inner = path.join(outer, 'packages', 'inner')
    fs.mkdirSync(inner, { recursive: true })
    const outerSvc = makeSvc({ name: 'outer', cwd: outer })
    const innerSvc = makeSvc({ name: 'inner', cwd: inner })
    const result = selectServicesToRestart(
      [outerSvc, innerSvc],
      [path.join(inner, 'src', 'a.ts')],
    )
    expect(result?.map((s) => s.name)).toEqual(['inner'])
  })

  it('ignores blank / non-string entries without failing the whole match', () => {
    const repo = mkTmp()
    const svc = makeSvc({ name: 'api', cwd: repo })
    const result = selectServicesToRestart(
      [svc],
      [path.join(repo, 'src', 'a.ts'), '', '   '],
    )
    expect(result?.map((s) => s.name)).toEqual(['api'])
  })
})

describe('restartServices', () => {
  it('restarts only the passed subset', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'kill').mockImplementation(((_: number, sig: any) => {
      if (sig === 0) return true
      return true
    }) as any)
    isHealthy.mockResolvedValue(true)

    const dir = mkTmp()
    const logA = path.join(dir, 'svc-a.log')
    const logB = path.join(dir, 'svc-b.log')
    fs.writeFileSync(logA, 'old-a')
    fs.writeFileSync(logB, 'old-b')
    const svcA = {
      name: 'svc-a', safeName: 'svc-a', logPath: logA,
      command: 'node a', cwd: '/',
    } as any
    const svcB = {
      name: 'svc-b', safeName: 'svc-b', logPath: logB,
      command: 'node b', cwd: '/',
    } as any
    openItermTabs.mockReturnValueOnce(['SID-A'])

    const p = restartServices([svcA], 'iTerm')
    await vi.advanceTimersByTimeAsync(5500)
    await p

    // Only A's log got wiped.
    expect(fs.readFileSync(logA, 'utf-8')).toBe('')
    expect(fs.readFileSync(logB, 'utf-8')).toBe('old-b')
    // Only one tab opened.
    const tabsArg = openItermTabs.mock.calls[0][0] as Array<{ name: string }>
    expect(tabsArg.map((t) => t.name)).toEqual(['svc-a'])
  })
})

describe('restartAllServices', () => {
  it('kills existing, truncates logs, opens tabs, polls health', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'kill').mockImplementation(((_: number, sig: any) => {
      if (sig === 0) return true
      return true
    }) as any)
    isHealthy.mockResolvedValue(true)

    const dir = mkTmp()
    const logPath = path.join(dir, 'svc-a.log')
    fs.writeFileSync(logPath, 'old')
    fs.writeFileSync(path.join(PIDS_DIR, 'svc-a.pid'), '999')
    const svc = {
      name: 'svc-a',
      safeName: 'svc-a',
      logPath,
      command: 'node a',
      cwd: '/',
      healthUrl: 'http://localhost:3000/',
    } as any
    openItermTabs.mockReturnValueOnce(['SID-A'])

    const p = restartAllServices([svc], 'iTerm')
    await vi.advanceTimersByTimeAsync(5500)
    await p

    expect(fs.readFileSync(logPath, 'utf-8')).toBe('')
    expect(openItermTabs).toHaveBeenCalledOnce()
    expect(isHealthy).toHaveBeenCalled()
  })

  it('skips kill step when no existing process is found', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    isHealthy.mockResolvedValue(true)

    const svc = {
      name: 's',
      safeName: 's',
      logPath: path.join(mkTmp(), 's.log'),
      command: 'x',
      cwd: '/',
    } as any
    openItermTabs.mockReturnValueOnce([])
    await restartAllServices([svc], 'iTerm')
    expect(openItermTabs).toHaveBeenCalledOnce()
  })
})

describe('runPlaywright', () => {
  function makeChild() {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
    }
    child.kill = vi.fn()
    return child
  }

  it('resolves with the child exit code on normal exit', async () => {
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', false)
    child.emit('exit', 0)
    await expect(p).resolves.toBe(0)
  })

  it('defaults to 1 when the child emits a null exit code', async () => {
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', true)
    child.emit('exit', null)
    await expect(p).resolves.toBe(1)
  })

  it('rejects when the child emits an error', async () => {
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', false)
    const err = new Error('boom')
    child.emit('error', err)
    await expect(p).rejects.toBe(err)
  })

  it('kills the child with SIGTERM (then SIGKILL) when the 10-minute timeout fires', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', false)
    // Advance past the 10-min timeout.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5100)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    // End the promise so the test doesn't hang.
    child.emit('exit', 143)
    await p
  })

  it('forwards SIGINT/SIGTERM from the parent process to the child', async () => {
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', false)
    process.emit('SIGINT' as any)
    process.emit('SIGTERM' as any)
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', 0)
    await p
  })

  it('inherits stdio and sets CANARY_LAB_BENCHMARK_MODE=canary by default', async () => {
    const child = makeChild()
    spawn.mockReturnValue(child)
    const p = runPlaywright('/feat', false)
    child.emit('exit', 0)
    await p
    const [, , opts] = spawn.mock.calls[0]
    expect(opts.stdio).toBe('inherit')
    expect(opts.env.CANARY_LAB_BENCHMARK_MODE).toBe('canary')
  })

  it('captures stdout+stderr to playwright-stdout.log and sets mode=baseline', async () => {
    // Ensure the log file doesn't exist from a prior test.
    try { fs.unlinkSync(PLAYWRIGHT_STDOUT_PATH) } catch { /* ignore */ }

    const child = makeChild() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    spawn.mockReturnValue(child)

    const p = runPlaywright('/feat', false, 'baseline')

    const [, , opts] = spawn.mock.calls[spawn.mock.calls.length - 1]
    expect(opts.stdio).toEqual(['inherit', 'pipe', 'pipe'])
    expect(opts.env.CANARY_LAB_BENCHMARK_MODE).toBe('baseline')

    child.stdout.emit('data', Buffer.from('stdout chunk\n'))
    child.stderr.emit('data', Buffer.from('stderr chunk\n'))
    child.emit('exit', 0)
    await p

    const contents = fs.readFileSync(PLAYWRIGHT_STDOUT_PATH, 'utf-8')
    expect(contents).toContain('stdout chunk')
    expect(contents).toContain('stderr chunk')
  })
})

describe('maybeAutoHeal', () => {
  function freshState() {
    return {
      spawnCount: 0,
      strikeCount: 0,
      lastSignature: '',
      disabled: false,
    }
  }

  it('is a no-op when no agent is configured', async () => {
    const state = freshState()
    await maybeAutoHeal({ agent: null, sessionMode: 'resume' }, state, 'iTerm')
    expect(spawnHealAgent).not.toHaveBeenCalled()
    expect(state).toEqual(freshState())
  })

  it('is a no-op when state.disabled is true', async () => {
    const state = { ...freshState(), disabled: true }
    await maybeAutoHeal({ agent: 'claude', sessionMode: 'resume' }, state, 'iTerm')
    expect(spawnHealAgent).not.toHaveBeenCalled()
  })

  it('is a no-op when there is no failure signature', async () => {
    const state = freshState()
    // No summary file → empty signature.
    await maybeAutoHeal({ agent: 'claude', sessionMode: 'resume' }, state, 'iTerm')
    expect(spawnHealAgent).not.toHaveBeenCalled()
  })

  it('spawns the heal agent on "signal" and increments spawnCount', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    spawnHealAgent.mockResolvedValueOnce('signal')
    const state = freshState()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal({ agent: 'claude', sessionMode: 'resume' }, state, 'iTerm')

    expect(spawnHealAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', sessionMode: 'resume', cycle: 0, terminal: 'iTerm' }),
    )
    expect(state.spawnCount).toBe(1)
    expect(state.lastSignature).toBe('a')
    expect(state.disabled).toBe(false)
  })

  it('writes benchmark context artifacts when benchmark mode is enabled', async () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        failed: [{ name: 'a', logs: { 'svc-api': 'boom happened' } }],
      }),
    )
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, '## Iteration 1 — 2026-04-22T00:00:00Z\n\n- hypothesis: x\n- outcome: pending\n')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    spawnHealAgent.mockResolvedValueOnce('signal')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const tracker = createBenchmarkTracker({
      runId: 'run-1',
      feature: 'checkout',
      benchmarkMode: 'canary',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: 'claude',
      maxCycles: 3,
      headed: false,
      autoHealEnabled: true,
      healSession: 'resume',
    })

    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      freshState(),
      'iTerm',
      tracker,
      'canary',
      3,
    )

    expect(fs.existsSync(path.join(BENCHMARK_DIR, 'context', 'cycle-1.json'))).toBe(true)
    expect(spawnHealAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        benchmarkUsageFile: path.join(BENCHMARK_DIR, 'usage', 'cycle-1.jsonl'),
      }),
    )
  })

  it('increments strikeCount when the signature repeats', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    spawnHealAgent.mockResolvedValue('signal')
    const state = { ...freshState(), lastSignature: 'a' }
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal({ agent: 'claude', sessionMode: 'resume' }, state, 'iTerm')
    expect(state.strikeCount).toBe(1)
  })

  it('disables auto-heal after reaching AUTO_HEAL_MAX_CYCLES strikes', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    const state = {
      spawnCount: 0,
      strikeCount: AUTO_HEAL_MAX_CYCLES - 1,
      lastSignature: 'a',
      disabled: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal({ agent: 'claude', sessionMode: 'resume' }, state, 'iTerm')

    expect(spawnHealAgent).not.toHaveBeenCalled()
    expect(state.disabled).toBe(true)
  })

  it('prints manual options when the agent exits without writing a signal', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    spawnHealAgent.mockResolvedValueOnce('agent_exited_no_signal')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const state = freshState()

    await maybeAutoHeal({ agent: 'codex', sessionMode: 'new' }, state, 'Terminal')

    const joined = logSpy.mock.calls.flat().join('\n')
    expect(joined).toContain('agent exited without writing')
    expect(joined).toContain('touch logs/.heal')
    expect(state.spawnCount).toBe(1)
  })

  it('prints manual options on agent timeout', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    spawnHealAgent.mockResolvedValueOnce('timeout')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      freshState(),
      'iTerm',
    )

    const joined = logSpy.mock.calls.flat().join('\n')
    expect(joined).toContain('timed out waiting for agent')
  })

  it('finalizes pending cycle + run when benchmark times out', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    spawnHealAgent.mockResolvedValueOnce('timeout')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const tracker = createBenchmarkTracker({
      runId: 'run-timeout',
      feature: 'checkout',
      benchmarkMode: 'canary',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: 'claude',
      maxCycles: 3,
      headed: false,
      autoHealEnabled: true,
      healSession: 'resume',
    })

    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      freshState(),
      'iTerm',
      tracker,
      'canary',
      3,
    )

    expect(tracker.pending).toBeNull()
    expect(tracker.finalized).toBe(true)
    expect(tracker.cycles).toHaveLength(1)
    expect(tracker.cycles[0].status).toBe('timeout')
    expect(tracker.cycles[0].success).toBe(false)
  })

  it('finalizes pending cycle + run when strike count reaches maxCycles', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [] }))
    spawnHealAgent.mockResolvedValue('signal')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const tracker = createBenchmarkTracker({
      runId: 'run-max',
      feature: 'checkout',
      benchmarkMode: 'canary',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: 'claude',
      maxCycles: 1,
      headed: false,
      autoHealEnabled: true,
      healSession: 'resume',
    })

    const state = freshState()
    // First call: spawns agent, returns 'signal', starts a pending cycle.
    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      state,
      'iTerm',
      tracker,
      'canary',
      1,
    )
    expect(tracker.pending).not.toBeNull()

    // Second call: same signature → strikeCount hits maxCycles → disables +
    // finalizes the pending cycle and the run with 'max_cycles_reached'.
    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      state,
      'iTerm',
      tracker,
      'canary',
      1,
    )

    expect(state.disabled).toBe(true)
    expect(tracker.pending).toBeNull()
    expect(tracker.finalized).toBe(true)
    expect(tracker.cycles).toHaveLength(1)
    expect(tracker.cycles[0].status).toBe('max_cycles_reached')
  })

  it('baseline mode filters manifest.repoPaths and passes them to the agent', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    fs.writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ serviceLogs: [], repoPaths: ['/repo/a', '/repo/b', 42, null] }),
    )
    spawnHealAgent.mockResolvedValueOnce('signal')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      freshState(),
      'iTerm',
      null,
      'baseline',
      3,
    )

    expect(spawnHealAgent).toHaveBeenCalled()
    const args = spawnHealAgent.mock.calls[0][0] as any
    expect(args.baselineRepoPaths).toEqual(['/repo/a', '/repo/b'])
    expect(args.agentCwd).toContain('canary-lab-baseline-')
    expect(args.baselinePlaywrightLogPath).toContain('canary-lab-baseline-')
  })

  it('baseline mode leaves repoPaths undefined when manifest is missing', async () => {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ failed: [{ name: 'a' }] }))
    // No MANIFEST_PATH.
    spawnHealAgent.mockResolvedValueOnce('signal')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await maybeAutoHeal(
      { agent: 'claude', sessionMode: 'resume' },
      freshState(),
      'iTerm',
      null,
      'baseline',
      3,
    )

    const args = spawnHealAgent.mock.calls[0][0] as any
    expect(args.baselineRepoPaths).toBeUndefined()
  })
})

describe('watchMode', () => {
  const RERUN_SIGNAL = path.join(LOGS_DIR, '.rerun')
  const RESTART_SIGNAL = path.join(LOGS_DIR, '.restart')
  const HEAL_SIGNAL = path.join(LOGS_DIR, '.heal')
  const SIGNAL_HISTORY_PATH = path.join(LOGS_DIR, 'signal-history.json')

  function makeChild() {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
      stdout: null
      stderr: null
    }
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    return child
  }

  it('removes stale signal files on entry before polling', async () => {
    fs.writeFileSync(RERUN_SIGNAL, '')
    fs.writeFileSync(RESTART_SIGNAL, '')
    fs.writeFileSync(HEAL_SIGNAL, '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()

    watchMode([], '/feat', false, 'Terminal', { agent: null, sessionMode: 'new' }, null, 'canary', 3)
      .catch(() => {}) // Swallow abandonment when test ends.
    await Promise.resolve()
    await Promise.resolve()

    expect(fs.existsSync(RERUN_SIGNAL)).toBe(false)
    expect(fs.existsSync(RESTART_SIGNAL)).toBe(false)
    expect(fs.existsSync(HEAL_SIGNAL)).toBe(false)
  })

  it('warns and appends to signal history when .heal fires without an agent', async () => {
    vi.useFakeTimers()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    watchMode([], '/feat', false, 'Terminal', { agent: null, sessionMode: 'new' }, null, 'canary', 3)
      .catch(() => {})
    // Let printBanner + initial maybeAutoHeal settle.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    fs.writeFileSync(HEAL_SIGNAL, '')
    // Poll tick.
    await vi.advanceTimersByTimeAsync(1100)
    await vi.advanceTimersByTimeAsync(100)

    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(allOutput).toContain('.heal signal received but no auto-heal agent is configured')

    // History was appended.
    const history = JSON.parse(fs.readFileSync(SIGNAL_HISTORY_PATH, 'utf-8'))
    expect(history).toHaveLength(1)
    expect(history[0].type).toBe('heal')
    // Heal signal was consumed.
    expect(fs.existsSync(HEAL_SIGNAL)).toBe(false)
  })

  it('on .rerun truncates service logs and re-runs Playwright', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const svcLogDir = mkTmp()
    const svcLogPath = path.join(svcLogDir, 'svc-web.log')
    fs.writeFileSync(svcLogPath, 'old output')
    const services = [
      { name: 'web', safeName: 'web', logPath: svcLogPath, command: 'x', cwd: '/' } as any,
    ]

    // Playwright child resolves immediately on exit 0.
    const child = makeChild()
    spawn.mockReturnValue(child)

    const promise = watchMode(
      services,
      '/feat',
      false,
      'Terminal',
      { agent: null, sessionMode: 'new' },
      null,
      'canary',
      3,
    ).catch(() => {})

    await Promise.resolve()
    fs.writeFileSync(RERUN_SIGNAL, JSON.stringify({ filesChanged: [] }))
    // Trigger poll + signal handling.
    await vi.advanceTimersByTimeAsync(1100)
    // Let runPlaywright start spawning.
    await Promise.resolve()
    // Fake child exits.
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(50)

    // Service log was truncated.
    expect(fs.readFileSync(svcLogPath, 'utf-8')).toBe('')
    // spawn called (runPlaywright).
    expect(spawn).toHaveBeenCalled()
    // Signal history recorded.
    const history = JSON.parse(fs.readFileSync(SIGNAL_HISTORY_PATH, 'utf-8'))
    expect(history[0].type).toBe('rerun')
    void promise
  })

  it('main() exits with code 1 when no features exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main([])).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('main() exits with code 1 when checkRepos fails (repo missing)', async () => {
    // Seed a feature with a repo that points to a non-existent path.
    const featDir = path.join(FEATURES_DIR, 'f1')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'f1',
        description: 'test',
        envs: ['dev'],
        repos: [{ name: 'missing', localPath: '/does/not/exist/here', startCommands: ['x'] }],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Select feature "1" then auto-heal "1" (None).
    readlineAnswers.push('1', '1')

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main([])).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('sets CANARY_LAB_SUMMARY_PATH to a tmpdir when --benchmark-mode=baseline is passed', async () => {
    // Seed a minimal feature with no repos so launch is a no-op.
    const featDir = path.join(FEATURES_DIR, 'baseline-feat')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'baseline-feat',
        description: 'test',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", auto-heal "1" (None).
    readlineAnswers.push('1', '1')

    // Playwright child resolves fast.
    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main(['--benchmark', '--benchmark-mode=baseline']).catch((e) => e)
    // Let main work through its setup up to the point where it sets env.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))

    expect(process.env.CANARY_LAB_SUMMARY_PATH ?? '').toContain('canary-lab-baseline-runner-')

    delete process.env.CANARY_LAB_SUMMARY_PATH
    void runPromise
  })

  it('on .restart with filesChanged, journals the iteration and triggers selective restart', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Two services; .restart filesChanged only matches the first repo's cwd.
    const repoA = mkTmp()
    const repoB = mkTmp()
    const svcLogA = path.join(mkTmp(), 'svc-a.log')
    const svcLogB = path.join(mkTmp(), 'svc-b.log')
    const services = [
      { name: 'a', safeName: 'a', logPath: svcLogA, command: 'ca', cwd: repoA } as any,
      { name: 'b', safeName: 'b', logPath: svcLogB, command: 'cb', cwd: repoB } as any,
    ]

    // Playwright child exits 0.
    const child = makeChild()
    spawn.mockReturnValue(child)

    const changedFile = path.join(repoA, 'src', 'handler.ts')
    const signal = {
      hypothesis: 'fixed the handler',
      filesChanged: [changedFile, 123, path.join(repoA, 'src', 'other.ts')],
      fixDescription: 'patched handler',
    }

    const promise = watchMode(
      services,
      '/feat',
      false,
      'Terminal',
      { agent: null, sessionMode: 'new' },
      null,
      'canary',
      3,
    ).catch(() => {})

    await Promise.resolve()
    fs.writeFileSync(RESTART_SIGNAL, JSON.stringify(signal))
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()

    // Journal was appended (fixDescription + hypothesis captured).
    const journal = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    expect(journal).toContain('fixed the handler')
    expect(journal).toContain('patched handler')

    // Signal history records the restart.
    const history = JSON.parse(fs.readFileSync(SIGNAL_HISTORY_PATH, 'utf-8'))
    expect(history[0].type).toBe('restart')

    // Signal consumed.
    expect(fs.existsSync(RESTART_SIGNAL)).toBe(false)
    void promise
  })

  it('on .restart without filesChanged, restarts all services', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const repoA = mkTmp()
    const svcLog = path.join(mkTmp(), 'svc-a.log')
    const services = [
      { name: 'a', safeName: 'a', logPath: svcLog, command: 'c', cwd: repoA } as any,
    ]

    const child = makeChild()
    spawn.mockReturnValue(child)

    const promise = watchMode(
      services,
      '/feat',
      false,
      'Terminal',
      { agent: null, sessionMode: 'new' },
      null,
      'canary',
      3,
    ).catch(() => {})

    await Promise.resolve()
    fs.writeFileSync(RESTART_SIGNAL, JSON.stringify({})) // no filesChanged → restartAll
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()
    // restartAllServices closes + reopens tabs; then polls health; then Playwright spawns.
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(50)

    expect(openTerminalTabs).toHaveBeenCalled()
    void promise
  })

  it('on .rerun, when tests turn green, finalizes benchmark run and closes iTerm heal tab', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Pre-seed summary with no failures so readFailureSignature() === ''
    // after Playwright "runs".
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ total: 0, passed: 0, failed: [] }))

    // Playwright child resolves immediately on exit 0.
    const child = makeChild()
    spawn.mockReturnValue(child)

    const tracker = createBenchmarkTracker({
      runId: 'run-green',
      feature: 'checkout',
      benchmarkMode: 'canary',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: 'claude',
      maxCycles: 3,
      headed: false,
      autoHealEnabled: true,
      healSession: 'resume',
    })
    // Arrange a pending cycle so finalizeBenchmarkCycle has something to close.
    const snapshot = {
      summaryBytes: 0,
      slicedLogBytes: 0,
      journalBytes: 0,
      rawServiceLogBytesAvailable: 0,
      filesIncluded: [],
      contextBytes: 0,
      contextChars: 0,
      promptAddendum: '',
    }
    tracker.pending = {
      cycle: 1,
      startedAt: '2026-04-21T00:00:01.000Z',
      startedAtMs: Date.now() - 1,
      failureSignature: 'a',
      signalWritten: null,
      usageFile: path.join(BENCHMARK_DIR, 'usage', 'cycle-1.jsonl'),
      snapshot,
    } as any

    const promise = watchMode(
      [],
      '/feat',
      false,
      'iTerm',
      { agent: 'claude', sessionMode: 'resume' },
      tracker,
      'canary',
      3,
    ).catch(() => {})

    await Promise.resolve()
    fs.writeFileSync(RERUN_SIGNAL, JSON.stringify({}))
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(tracker.pending).toBeNull()
    expect(tracker.cycles[0]?.greenAfterCycle).toBe(true)
    expect(tracker.finalized).toBe(true)
    expect(closeLastHealAgentTab).toHaveBeenCalled()
    void promise
  })

  it('on .heal with an agent configured resets strikes and re-engages auto-heal', async () => {
    // Seed a failure so maybeAutoHeal has something to react to.
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({ total: 1, passed: 0, failed: [{ name: 'checkout' }] }),
    )
    spawnHealAgent.mockResolvedValue('signal')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()

    watchMode(
      [],
      '/feat',
      false,
      'Terminal',
      { agent: 'claude', sessionMode: 'new' },
      null,
      'canary',
      3,
    ).catch(() => {})

    // Let the initial maybeAutoHeal call run.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    spawnHealAgent.mockClear()

    // Now fire the .heal signal.
    fs.writeFileSync(HEAL_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1100)
    await Promise.resolve()
    await Promise.resolve()

    // Heal was consumed and a second auto-heal was spawned.
    expect(fs.existsSync(HEAL_SIGNAL)).toBe(false)
    expect(spawnHealAgent).toHaveBeenCalled()
  })

  it('main() prompts for env when a feature has multiple envs', async () => {
    const featDir = path.join(FEATURES_DIR, 'multi-env')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'multi-env',
        description: 't',
        envs: ['dev', 'staging'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", env "2" (staging), auto-heal "1" (None).
    readlineAnswers.push('1', '2', '1')

    const questionSpy = vi.spyOn(rlMock, 'question')
    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    // Three prompts fired: feature, env, auto-heal.
    expect(questionSpy).toHaveBeenCalledTimes(3)
    void runPromise
  })

  it('main() rethrows non-HCT errors from pollHealthChecks without calling the recovery UI', async () => {
    const repoDir = mkTmp()
    const featDir = path.join(FEATURES_DIR, 'hc-boom')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'hc-boom',
        description: 't',
        envs: ['dev'],
        repos: [{
          name: 'r', localPath: ${JSON.stringify(repoDir)}, startCommands: [{
            name: 'svc', command: 'noop',
            healthCheck: { url: 'http://localhost:59998/', timeoutMs: 5 },
          }],
        }],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    isHealthy.mockRejectedValueOnce(new Error('network-down'))

    readlineAnswers.push('1', '1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main(['--terminal', 'Terminal'])).rejects.toThrow('network-down')
  })

  it('main() delegates to handleHealthCheckFailure when pollHealthChecks throws HCT', async () => {
    const repoDir = mkTmp()
    const featDir = path.join(FEATURES_DIR, 'hc-fail')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'hc-fail',
        description: 't',
        envs: ['dev'],
        repos: [{
          name: 'r', localPath: ${JSON.stringify(repoDir)}, startCommands: [{
            name: 'svc', command: 'noop',
            healthCheck: { url: 'http://localhost:59999/', timeoutMs: 5 },
          }],
        }],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Short-circuit pollHealthChecks by throwing HCT directly from isHealthy.
    isHealthy.mockImplementation(async () => {
      throw new HealthCheckTimeoutError('svc', 'http://localhost:59999/')
    })

    // Answers: feature "1", auto-heal "1" (None), HHCF prompt "1" (Stop).
    readlineAnswers.push('1', '1', '1')

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main(['--terminal', 'Terminal'])).rejects.toBeInstanceOf(
      HealthCheckTimeoutError,
    )
  })

  it('main() auto-selects the only env set when it does not match the env name', async () => {
    const featDir = path.join(FEATURES_DIR, 'single-envset-mismatch')
    fs.mkdirSync(path.join(featDir, 'envsets', 'staging'), { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'envsets', 'envsets.config.json'),
      JSON.stringify({ slots: {}, feature: { slots: [] }, appRoots: {} }),
    )
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'single-envset-mismatch',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )
    // env 'dev' doesn't match envset 'staging' → single fallback auto-selects 'staging'.
    readlineAnswers.push('1', '1')

    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    const applyCall = execFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--apply'),
    )
    expect(applyCall).toBeDefined()
    const applyArgs = applyCall![1] as string[]
    expect(applyArgs[applyArgs.length - 1]).toBe('staging')
    void runPromise
  })

  it('main() prompts to pick env set when multiple sets exist and none match env', async () => {
    const featDir = path.join(FEATURES_DIR, 'multi-envset')
    fs.mkdirSync(path.join(featDir, 'envsets', 'staging'), { recursive: true })
    fs.mkdirSync(path.join(featDir, 'envsets', 'prod'), { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'envsets', 'envsets.config.json'),
      JSON.stringify({ slots: {}, feature: { slots: [] }, appRoots: {} }),
    )
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'multi-envset',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )
    // env 'dev' doesn't match either envset → user picks "1" = prod (sorted first).
    readlineAnswers.push('1', '1', '1')

    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    const applyCall = execFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--apply'),
    )
    expect(applyCall).toBeDefined()
    const applyArgs = applyCall![1] as string[]
    expect(applyArgs[applyArgs.length - 1]).toBe('prod')
    void runPromise
  })

  it('main() applies env set via switch-env when envsets dir present', async () => {
    const featDir = path.join(FEATURES_DIR, 'envsets-feat')
    fs.mkdirSync(path.join(featDir, 'envsets', 'dev'), { recursive: true })
    fs.mkdirSync(path.join(featDir, 'envsets', 'staging'), { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'envsets', 'envsets.config.json'),
      JSON.stringify({ slots: {}, feature: { slots: [] }, appRoots: {} }),
    )
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'envsets-feat',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", auto-heal "1" (None). env auto-selected (single).
    readlineAnswers.push('1', '1')

    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    // Find the --apply call among execFileSync calls.
    const applyCall = execFileSync.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes('--apply'),
    )
    expect(applyCall).toBeDefined()
    const applyArgs = applyCall![1] as string[]
    // Chosen set should be 'dev' (matches env name, even though 'staging' also exists).
    expect(applyArgs[applyArgs.length - 1]).toBe('dev')
    void runPromise
  })

  it('main() prints the drift notice when formatDriftNotice returns a string', async () => {
    formatDriftNotice.mockReturnValueOnce(
      'canary-lab: installed version is 9.9.9, but scaffolded files were last synced at 0.0.1.\nRun `npx canary-lab upgrade`.',
    )

    const featDir = path.join(FEATURES_DIR, 'drifty')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'drifty',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    readlineAnswers.push('1', '1')
    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    const allLogged = logSpy.mock.calls.flat().join('\n')
    expect(allLogged).toMatch(/canary-lab upgrade/)
    void runPromise
  })

  it('main() accepts the Claude auto-heal choice and runs Playwright', async () => {
    const featDir = path.join(FEATURES_DIR, 'with-claude')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'with-claude',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )
    // Answers: feature "1", auto-heal "2" (Claude).
    readlineAnswers.push('1', '2')
    isAgentCliAvailable.mockReturnValue(true)

    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => child.emit('exit', 0))
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main([]).catch((e) => e)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))

    expect(spawn).toHaveBeenCalled() // Playwright was spawned (agent branch survived).
    void runPromise
  })

  it('main() exits 1 when chosen heal agent CLI is not on PATH', async () => {
    const featDir = path.join(FEATURES_DIR, 'no-cli')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'no-cli',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", auto-heal "3" (Codex).
    readlineAnswers.push('1', '3')
    isAgentCliAvailable.mockReturnValue(false)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as any)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(main([])).rejects.toThrow('process.exit(1)')
    const joined = errSpy.mock.calls.flat().join('\n')
    expect(joined).toContain('`codex` CLI not found on PATH')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('main() cleanup: stops services, reverts env, and warns when revert fails', async () => {
    // Seed feature with a repo + startCommand, envsets dir so env apply fires.
    const featDir = path.join(FEATURES_DIR, 'cleanup-feat')
    const envsetsDir = path.join(featDir, 'envsets', 'dev')
    fs.mkdirSync(envsetsDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'envsets', 'envsets.config.json'),
      JSON.stringify({ slots: {}, feature: { slots: [] }, appRoots: {} }),
    )
    const repoDir = mkTmp()
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'cleanup-feat',
        description: 't',
        envs: ['dev'],
        repos: [{ name: 'app', localPath: ${JSON.stringify(repoDir)}, startCommands: ['npm run dev'] }],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", auto-heal "1" (None).
    readlineAnswers.push('1', '1')

    // buildServiceList() derives safeName from the command — 'app-cmd-1'.
    // main() wipes logs/ at step 8 and re-mkdirs PIDS_DIR, so we write the pid
    // file via the mocked openTerminalTabs (invoked from launchServices, which
    // runs AFTER step 8).
    const safeName = 'app-cmd-1'
    openTerminalTabs.mockImplementation(() => {
      fs.writeFileSync(path.join(PIDS_DIR, `${safeName}.pid`), '12345')
    })

    // execFileSync is used twice: once for env --apply (success), once for
    // env --revert inside cleanup (we throw → hits the warn branch).
    let applyCalled = false
    execFileSync.mockImplementation((_cmd: any, args: any) => {
      if (Array.isArray(args) && args.includes('--revert')) {
        throw new Error('revert fail')
      }
      if (Array.isArray(args) && args.includes('--apply')) {
        applyCalled = true
        return ''
      }
      return ''
    })

    // process.kill: pretend the pid exists and is killable.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig: any) => {
      if (sig === 0) return true as any // alive
      return true as any
    }) as any)

    // spawn (Playwright) — make it throw so main() hits its catch → cleanup().
    spawn.mockImplementationOnce(() => {
      throw new Error('playwright-crash')
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main(['--terminal', 'Terminal'])).rejects.toThrow('playwright-crash')

    expect(applyCalled).toBe(true)
    // killProcessSync sent SIGTERM to our pid.
    const killSignals = killSpy.mock.calls.map((c) => c[1])
    expect(killSignals).toContain('SIGTERM')
    // Cleanup logged "Stopping services..." and "Reverting env files...".
    const logs = logSpy.mock.calls.flat().join('\n')
    expect(logs).toContain('Stopping services')
    expect(logs).toContain('Reverting env files')
    // Warn on revert failure reached.
    expect(logs).toMatch(/env revert failed/)
  })

  it('main() cleanup: finalizes benchmark as interrupted when throwing mid-run', async () => {
    const featDir = path.join(FEATURES_DIR, 'interrupted-feat')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'interrupted-feat',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    readlineAnswers.push('1', '1')

    // Crash Playwright → main rejects → cleanup finalizes interrupted.
    spawn.mockImplementationOnce(() => {
      throw new Error('playwright-crash')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main(['--benchmark'])).rejects.toThrow('playwright-crash')

    const summaryFile = path.join(BENCHMARK_DIR, 'final-summary.json')
    expect(fs.existsSync(summaryFile)).toBe(true)
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'))
    expect(summary.finalStatus).toBe('interrupted')
    expect(summary.success).toBe(false)
  })

  it('main() cleanup: removes baseline runner tmp dir on throw', async () => {
    const featDir = path.join(FEATURES_DIR, 'baseline-cleanup')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'baseline-cleanup',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )
    readlineAnswers.push('1', '1')

    spawn.mockImplementationOnce(() => {
      throw new Error('playwright-crash')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      main(['--benchmark', '--benchmark-mode=baseline']),
    ).rejects.toThrow('playwright-crash')

    // CANARY_LAB_SUMMARY_PATH was pointed at <tmp>/canary-lab-baseline-runner-<id>/...
    // Cleanup removes that parent dir. Verify both that the env var pointed at
    // such a path and the parent dir no longer exists.
    const summaryPath = process.env.CANARY_LAB_SUMMARY_PATH!
    expect(summaryPath).toContain('canary-lab-baseline-runner-')
    expect(fs.existsSync(path.dirname(summaryPath))).toBe(false)
    delete process.env.CANARY_LAB_SUMMARY_PATH
  })

  it('main() SIGINT handler runs cleanup and exits 130', async () => {
    const featDir = path.join(FEATURES_DIR, 'sigint-feat')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'sigint-feat',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )
    readlineAnswers.push('1', '1')

    // Playwright spawn hangs — don't emit exit. SIGINT will break us out.
    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => child)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code}`)
    }) as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const existingSigint = process.listeners('SIGINT').slice()
    const existingSigterm = process.listeners('SIGTERM').slice()

    const runPromise = main([]).catch(() => {})
    // Let main register its handlers.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

    // Fire SIGINT; main's handler calls cleanup + process.exit(130).
    expect(() => process.emit('SIGINT' as any)).toThrow('__exit__130')

    // Fire SIGTERM for coverage too; note cleanup() is idempotent via cleanedUp.
    // Register a fresh instance by running another pass — we re-trigger the
    // registered listener directly.
    const sigtermListeners = process
      .listeners('SIGTERM')
      .filter((l) => !existingSigterm.includes(l))
    expect(sigtermListeners.length).toBeGreaterThan(0)
    expect(() => (sigtermListeners[0] as () => void)()).toThrow('__exit__143')

    // Cleanup the listeners we added so later tests don't inherit them.
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    for (const l of existingSigint) process.on('SIGINT', l as any)
    for (const l of existingSigterm) process.on('SIGTERM', l as any)

    exitSpy.mockRestore()
    void runPromise
  })

  it('main() finalizes benchmark as manual_only when no agent + failures remain', async () => {
    const featDir = path.join(FEATURES_DIR, 'manual-only-feat')
    fs.mkdirSync(featDir, { recursive: true })
    fs.writeFileSync(
      path.join(featDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'manual-only-feat',
        description: 't',
        envs: ['dev'],
        repos: [],
        featureDir: ${JSON.stringify(featDir)},
      } }`,
    )

    // Answers: feature "1", auto-heal "1" (None).
    readlineAnswers.push('1', '1')

    const child = new EventEmitter() as any
    child.kill = vi.fn()
    child.stdout = null
    child.stderr = null
    spawn.mockImplementation(() => {
      setImmediate(() => {
        // Simulate Playwright reporter writing a red summary, then exiting.
        fs.writeFileSync(
          SUMMARY_PATH,
          JSON.stringify({ total: 1, passed: 0, failed: [{ name: 'still-red' }] }),
        )
        child.emit('exit', 1)
      })
      return child
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const runPromise = main(['--benchmark']).catch((e) => e)
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))

    const summaryFile = path.join(BENCHMARK_DIR, 'final-summary.json')
    expect(fs.existsSync(summaryFile)).toBe(true)
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'))
    expect(summary.finalStatus).toBe('manual_only')
    expect(summary.success).toBe(false)
    void runPromise
  })
})

// ─── Startup-failure recovery ──────────────────────────────────────────────

describe('HealthCheckTimeoutError', () => {
  it('carries serviceName + healthUrl and is an Error instance', () => {
    const err = new HealthCheckTimeoutError('svc-a', 'http://localhost:9999/health')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HealthCheckTimeoutError)
    expect(err.name).toBe('HealthCheckTimeoutError')
    expect(err.serviceName).toBe('svc-a')
    expect(err.healthUrl).toBe('http://localhost:9999/health')
    expect(err.message).toBe('Health check timed out for svc-a at http://localhost:9999/health')
  })

  it('is thrown by pollHealthChecks when a service never becomes healthy', async () => {
    isHealthy.mockResolvedValue(false)
    const services = [
      {
        name: 'svc-a',
        safeName: 'svc-a',
        logPath: '/tmp/svc-a.log',
        command: 'run',
        cwd: '/tmp/repo',
        healthUrl: 'http://localhost:9999/health',
        healthTimeout: 10,
      },
    ]
    // Use a tiny timeout so the test is fast.
    await expect(pollHealthChecks(services, 20)).rejects.toBeInstanceOf(
      HealthCheckTimeoutError,
    )
  })
})

describe('handleHealthCheckFailure', () => {
  const makeService = (name: string, port: number, repoPath = '/repo/app') => ({
    name,
    safeName: name,
    logPath: `${LOGS_DIR}/svc-${name}.log`,
    command: 'npm start',
    cwd: repoPath,
    healthUrl: `http://localhost:${port}/health`,
    healthTimeout: 10,
  })

  const makeFeature = (): FeatureConfig =>
    ({
      name: 'feat',
      description: 'test',
      envs: ['local'],
      repos: [],
      featureDir: '/feat',
    }) as any

  it('returns false when the user picks "Stop services and exit"', async () => {
    const select = vi.fn(async (_rl: any, _label: string, options: string[]) => options[0])
    const spawnAgent = vi.fn()
    const waitForSignal = vi.fn()

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      spawnAgent,
      waitForSignal,
      agentCliAvailable: () => true,
    })

    expect(result).toBe(false)
    expect(spawnAgent).not.toHaveBeenCalled()
    expect(waitForSignal).not.toHaveBeenCalled()
  })

  it('spawns the agent with buildStartupFailurePrompt content when Claude option is chosen', async () => {
    // Pick "Claude" on first prompt (index 2 → label).
    const select = vi.fn(async (_rl: any, _label: string, options: string[]) => {
      const claudeOpt = options.find((o) => o.includes('Claude'))
      expect(claudeOpt).toBeDefined()
      return claudeOpt!
    })
    // Agent returns 'signal', runner restarts, health check passes.
    const spawnAgent = vi.fn(async () => 'signal')
    const restartSelected = vi.fn(async () => {})
    const restartAll = vi.fn(async () => {})

    // Seed a .restart signal so consumeSignalAndReadFilesChanged sees it.
    fs.writeFileSync(
      path.join(LOGS_DIR, '.restart'),
      JSON.stringify({ hypothesis: 'bad port', filesChanged: ['/repo/app/src/server.ts'] }),
    )

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000, '/repo/app')],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'resume',
      selectChoice: select,
      spawnAgent: spawnAgent as any,
      agentCliAvailable: () => true,
      restartSelected,
      restartAll,
    })

    expect(result).toBe(true)
    expect(spawnAgent).toHaveBeenCalledOnce()
    const spawnArgs = spawnAgent.mock.calls[0][0] as any
    expect(spawnArgs.agent).toBe('claude')
    expect(spawnArgs.basePromptOverride).toContain('MOCK STARTUP PROMPT for svc-a')
    // Selective restart (filesChanged mapped to /repo/app).
    expect(restartSelected).toHaveBeenCalledOnce()
    expect(restartAll).not.toHaveBeenCalled()
    // Signal files were consumed.
    expect(fs.existsSync(path.join(LOGS_DIR, '.restart'))).toBe(false)
  })

  it('omits auto-heal options when neither CLI is available', async () => {
    let presentedOptions: string[] | null = null
    const select = vi.fn(async (_rl: any, _label: string, options: string[]) => {
      presentedOptions = options
      return options[0] // Stop
    })

    await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      agentCliAvailable: () => false,
    })

    expect(presentedOptions).not.toBeNull()
    expect(presentedOptions).toHaveLength(2) // Stop + manual only
    expect(presentedOptions!.some((o) => o.includes('Claude'))).toBe(false)
    expect(presentedOptions!.some((o) => o.includes('Codex'))).toBe(false)
  })

  it('uses manual self-heal path and restarts when the user writes .rerun', async () => {
    const select = vi.fn(async (_rl: any, _label: string, options: string[]) =>
      options.find((o) => o.includes('manually'))!,
    )
    const waitForSignal = vi.fn(async () => 'signal' as const)
    const restartAll = vi.fn(async () => {})

    fs.writeFileSync(path.join(LOGS_DIR, '.rerun'), '')

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      waitForSignal,
      agentCliAvailable: () => false,
      restartAll,
    })

    expect(result).toBe(true)
    expect(waitForSignal).toHaveBeenCalled()
    // No filesChanged → full restart.
    expect(restartAll).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(LOGS_DIR, '.rerun'))).toBe(false)
  })

  it('returns false immediately when the failing service is not in the list', async () => {
    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'ghost',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: vi.fn(async (_rl, _l, opts) => opts[0]),
      spawnAgent: vi.fn(),
      agentCliAvailable: () => true,
    })
    expect(result).toBe(false)
  })

  it('re-prompts after 3 agent cycles that exit without a signal', async () => {
    let promptCount = 0
    const select = vi.fn(async (_rl, _l, options: string[]) => {
      promptCount += 1
      if (promptCount === 1) return options.find((o) => o.includes('Claude'))!
      return options[0] // Stop
    })
    const spawnAgent = vi.fn(async () => 'agent_exited_no_signal' as const)

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      spawnAgent: spawnAgent as any,
      agentCliAvailable: () => true,
      restartAll: vi.fn(),
      restartSelected: vi.fn(),
    })

    expect(spawnAgent).toHaveBeenCalledTimes(3)
    expect(result).toBe(false)
  })

  it('re-prompts when the manual-wait times out without a signal', async () => {
    let promptCount = 0
    const select = vi.fn(async (_rl, _l, options: string[]) => {
      promptCount += 1
      if (promptCount === 1) {
        return options.find((o) => o.includes('self heal manually'))!
      }
      return options[0] // Stop
    })
    const waitForSignal = vi.fn(async () => 'timeout' as const)

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      waitForSignal,
      agentCliAvailable: () => true,
      restartAll: vi.fn(),
    })

    expect(waitForSignal).toHaveBeenCalled()
    expect(promptCount).toBeGreaterThanOrEqual(2)
    expect(result).toBe(false)
  })

  it('rethrows non-HealthCheckTimeoutError from the restart hook', async () => {
    const select = vi.fn(async (_rl, _l, options: string[]) =>
      options.find((o) => o.includes('Claude'))!,
    )
    const spawnAgent = vi.fn(async () => {
      fs.writeFileSync(path.join(LOGS_DIR, '.restart'), '')
      return 'signal' as const
    })
    const restartAll = vi.fn(async () => {
      throw new Error('unexpected-boom')
    })

    await expect(
      handleHealthCheckFailure({
        rl: rlMock as any,
        failingServiceName: 'svc-a',
        services: [makeService('svc-a', 3000)],
        feature: makeFeature(),
        terminal: 'iTerm',
        benchmarkMode: 'canary',
        healSession: 'new',
        selectChoice: select,
        spawnAgent: spawnAgent as any,
        agentCliAvailable: () => true,
        restartAll,
      }),
    ).rejects.toThrow('unexpected-boom')
  })

  it('uses default restartAllServices closure when no restartAll opt and no filesChanged', async () => {
    const svc = {
      name: 'svc-a',
      safeName: 'svc-a',
      logPath: '/tmp/svc-a.log',
      command: 'run',
      cwd: '/tmp/repo',
    } as any
    const select = vi.fn(async (_rl, _l, opts) =>
      opts.find((o: string) => o.includes('self heal manually'))!,
    )
    const waitForSignal = vi.fn(async () => {
      // No filesChanged → selectServicesToRestart returns null → restartAll path.
      fs.writeFileSync(path.join(LOGS_DIR, '.restart'), JSON.stringify({}))
      return 'signal' as const
    })

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [svc],
      feature: makeFeature(),
      terminal: 'Terminal',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      waitForSignal,
      agentCliAvailable: () => false,
    })

    expect(result).toBe(true)
    expect(closeTerminalTabsByPrefix).toHaveBeenCalled()
    expect(openTerminalTabs).toHaveBeenCalled()
  })

  it('uses default restart closures (restartServices/restartAllServices) when none provided', async () => {
    // Service with no healthUrl → restartServices → pollHealthChecks is a no-op.
    const svc = {
      name: 'svc-a',
      safeName: 'svc-a',
      logPath: '/tmp/svc-a.log',
      command: 'run',
      cwd: '/tmp/repo',
    } as any
    const select = vi.fn(async (_rl, _l, opts) =>
      opts.find((o: string) => o.includes('self heal manually'))!,
    )
    const waitForSignal = vi.fn(async () => {
      // Write .restart with filesChanged matching svc.cwd so selective branch runs.
      fs.writeFileSync(
        path.join(LOGS_DIR, '.restart'),
        JSON.stringify({ filesChanged: ['/tmp/repo/src/a.ts'] }),
      )
      return 'signal' as const
    })

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [svc],
      feature: makeFeature(),
      terminal: 'Terminal',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      waitForSignal,
      agentCliAvailable: () => false, // skip auto-heal branches to force manual
    })

    expect(result).toBe(true)
    // Default restartSelected path ran → Terminal tabs were re-opened.
    expect(openTerminalTabs).toHaveBeenCalled()
  })

  it('re-prompts after 3 failing cycles instead of bailing out silently', async () => {
    let promptCount = 0
    const select = vi.fn(async (_rl: any, _label: string, options: string[]) => {
      promptCount += 1
      // First prompt: pick Claude. Second prompt: pick Stop.
      if (promptCount === 1) return options.find((o) => o.includes('Claude'))!
      return options[0] // Stop
    })

    // Agent succeeds in writing a signal each cycle, but restart keeps failing
    // health check, so we loop the full 3 cycles then re-prompt.
    const spawnAgent = vi.fn(async () => {
      fs.writeFileSync(path.join(LOGS_DIR, '.restart'), '')
      return 'signal'
    })
    const restartAll = vi.fn(async () => {
      throw new HealthCheckTimeoutError('svc-a', 'http://localhost:3000/health')
    })

    const result = await handleHealthCheckFailure({
      rl: rlMock as any,
      failingServiceName: 'svc-a',
      services: [makeService('svc-a', 3000)],
      feature: makeFeature(),
      terminal: 'iTerm',
      benchmarkMode: 'canary',
      healSession: 'new',
      selectChoice: select,
      spawnAgent: spawnAgent as any,
      agentCliAvailable: () => true,
      restartAll,
    })

    expect(promptCount).toBe(2)
    expect(spawnAgent).toHaveBeenCalledTimes(3)
    expect(result).toBe(false) // second prompt returned Stop
  })
})
