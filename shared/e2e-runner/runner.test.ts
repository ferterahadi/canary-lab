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
const DIAGNOSIS_JOURNAL_PATH = path.join(LOGS_DIR, 'diagnosis-journal.json')
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
  RERUN_SIGNAL: path.join(LOGS_DIR, '.rerun'),
  RESTART_SIGNAL: path.join(LOGS_DIR, '.restart'),
  HEAL_SIGNAL: path.join(LOGS_DIR, '.heal'),
  SIGNAL_HISTORY_PATH: path.join(LOGS_DIR, 'signal-history.json'),
  ITERM_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-session-ids.json'),
  ITERM_HEAL_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-heal-session-ids.json'),
}))

const execFileSync = vi.fn()
const spawn = vi.fn()
vi.mock('child_process', () => ({ execFileSync, spawn }))

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
vi.mock('./auto-heal', () => ({
  spawnHealAgent,
  closeLastHealAgentTab,
  isAgentCliAvailable,
  failureSignature: failureSignatureMock,
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
  runPlaywright,
  maybeAutoHeal,
  AUTO_HEAL_MAX_CYCLES,
  itermSessionIds,
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
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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
  it('wraps the command with LOG_MODE=plain and pipes to tee', () => {
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
})

describe('enrichSummaryWithLogs', () => {
  it('replaces failed[] entries with { name, logs } using extracted snippets', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [{ name: 'test-case-bad' }],
      }),
    )
    const logPath = path.join(LOGS_DIR, 'svc-x.log')
    fs.writeFileSync(logPath, '<test-case-bad>\nlog body\n</test-case-bad>')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [logPath] }))

    enrichSummaryWithLogs()

    const out = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
    expect(out.failed).toEqual([
      { name: 'test-case-bad', logs: { 'svc-x': 'log body' } },
    ])
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
    expect(joined).toContain('Total:  2')
    expect(joined).toContain('Passed: 1')
    expect(joined).toContain('Failed: 2')
    expect(joined).toContain('- test-case-a')
    expect(joined).toContain('- test-case-b')
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
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, JSON.stringify([{ hypothesis: 'x' }]))
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
})
