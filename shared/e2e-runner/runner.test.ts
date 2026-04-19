import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
const PIDS_DIR = path.join(LOGS_DIR, 'pids')
const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
fs.mkdirSync(FEATURES_DIR, { recursive: true })
fs.mkdirSync(PIDS_DIR, { recursive: true })

vi.mock('./paths', () => ({
  ROOT: PATH_ROOT,
  FEATURES_DIR,
  LOGS_DIR,
  PIDS_DIR,
  MANIFEST_PATH,
  SUMMARY_PATH,
  RERUN_SIGNAL: path.join(LOGS_DIR, '.rerun'),
  RESTART_SIGNAL: path.join(LOGS_DIR, '.restart'),
  HEAL_SIGNAL: path.join(LOGS_DIR, '.heal'),
  SIGNAL_HISTORY_PATH: path.join(LOGS_DIR, 'signal-history.json'),
  ITERM_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-session-ids.json'),
  ITERM_HEAL_SESSION_IDS_PATH: path.join(LOGS_DIR, 'iterm-heal-session-ids.json'),
}))

const execFileSync = vi.fn()
vi.mock('child_process', () => ({ execFileSync, spawn: vi.fn() }))

// Silence iterm/terminal boundaries for any test that reaches them.
vi.mock('../launcher/iterm', () => ({
  openItermTabs: vi.fn(() => []),
  closeItermSessionsByPrefix: vi.fn(),
  closeItermSessionsByIds: vi.fn(),
}))
vi.mock('../launcher/terminal', () => ({
  openTerminalTabs: vi.fn(),
  closeTerminalTabsByPrefix: vi.fn(),
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
  extractLogsForTest,
  enrichSummaryWithLogs,
  printSummary,
  readFailureSignature,
  printManualOptions,
} = await import('./runner')

beforeEach(() => {
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => '')
})

afterEach(() => {
  vi.restoreAllMocks()
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
