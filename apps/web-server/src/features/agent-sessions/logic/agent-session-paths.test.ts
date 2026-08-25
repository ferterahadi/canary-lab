import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  encodeClaudeProjectDir,
  claudeProjectDirCandidates,
  claudeConfigDir,
  codexConfigDir,
  claudeSessionLogPath,
  locateClaudeSessionLog,
  findClaudeLogBySessionId,
  locateLatestClaudeSessionLog,
  locateCodexSessionLog,
  locateLatestCodexSessionLog,
  locateLatestSessionLogForAgent,
  locateMostRecentAgentSessionRef,
  loadAgentSessionLog,
  loadAgentSession,
  loadAgentSessionMeta,
  parseAgentSessionRefFile,
  renderAgentSessionContext,
  buildFullSessionTranscript,
  writeFullSessionTranscript,
  selectAgentSessionRef,
  resolveManifestSessionRef,
  writeWorkflowAgentRef,
  resolveWorkflowAgentRef,
  buildAgentSessionResponse,
  parseAgentSessionLine,
  loadSubagentThread,
  loadSubagentThreads,
  subagentDirFor,
} from './agent-session-log'

let homeDir: string

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-home-')))
})

afterEach(() => {
  try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('claudeSessionLogPath', () => {
  it('returns the expected path for a real directory', () => {
    const result = claudeSessionLogPath(homeDir, 'sess-1', homeDir)
    expect(result).toBe(path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(homeDir), 'sess-1.jsonl'))
  })

  it('falls back to raw cwd when realpathSync throws (lines 118-119 catch branch)', () => {
    // Pass a non-existent path so realpathSync throws ENOENT.
    const fakeCwd = '/this/path/does/not/exist'
    const result = claudeSessionLogPath(fakeCwd, 'sess-2', homeDir)
    expect(result).toBe(path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(fakeCwd), 'sess-2.jsonl'))
  })
})

describe('config-dir resolution (env overrides)', () => {
  const savedClaude = process.env.CLAUDE_CONFIG_DIR
  const savedCodex = process.env.CODEX_HOME
  afterEach(() => {
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
    if (savedCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodex
  })

  it('falls back to the home dotdir when no override is set', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CODEX_HOME
    expect(claudeConfigDir(homeDir)).toBe(path.join(homeDir, '.claude'))
    expect(codexConfigDir(homeDir)).toBe(path.join(homeDir, '.codex'))
  })

  it('honors CLAUDE_CONFIG_DIR / CODEX_HOME over the home dotdir', () => {
    process.env.CLAUDE_CONFIG_DIR = '/relocated/claude'
    process.env.CODEX_HOME = '/relocated/codex'
    expect(claudeConfigDir(homeDir)).toBe('/relocated/claude')
    expect(codexConfigDir(homeDir)).toBe('/relocated/codex')
  })

  it('ignores a blank/whitespace override', () => {
    process.env.CLAUDE_CONFIG_DIR = '   '
    process.env.CODEX_HOME = ''
    expect(claudeConfigDir(homeDir)).toBe(path.join(homeDir, '.claude'))
    expect(codexConfigDir(homeDir)).toBe(path.join(homeDir, '.codex'))
  })

  it('finds a claude log under CLAUDE_CONFIG_DIR when the home dotdir is empty', () => {
    const relocated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-cfg-')))
    process.env.CLAUDE_CONFIG_DIR = relocated
    const sessionId = 'relocated-sid'
    const projectDir = path.join(relocated, 'projects', '-some-proj')
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')
    try {
      // homeDir has no `.claude` at all — the only way this resolves is via the override.
      expect(findClaudeLogBySessionId(sessionId, homeDir)).toBe(jsonl)
    } finally {
      fs.rmSync(relocated, { recursive: true, force: true })
    }
  })

  it('discovers a codex log under CODEX_HOME', () => {
    const relocated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-cdx-')))
    process.env.CODEX_HOME = relocated
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const dir = path.join(relocated, 'sessions', '2026', '05', '11')
    fs.mkdirSync(dir, { recursive: true })
    const jsonl = path.join(dir, 'rollout-2026-05-11T01-23-00-abc.jsonl')
    fs.writeFileSync(
      jsonl,
      JSON.stringify({ type: 'session_meta', timestamp: '2026-05-11T01:23:00.000Z', payload: { id: 'cdx-1', cwd: runDir, timestamp: '2026-05-11T01:23:00.000Z' } }) + '\n',
    )
    try {
      expect(locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)).toEqual({
        agent: 'codex',
        sessionId: 'cdx-1',
        logPath: jsonl,
      })
    } finally {
      fs.rmSync(relocated, { recursive: true, force: true })
      fs.rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('encodeClaudeProjectDir', () => {
  it('replaces every / with - so /Users/dev/foo becomes -Users-dev-foo', () => {
    expect(encodeClaudeProjectDir('/Users/dev/foo')).toBe('-Users-dev-foo')
  })

  it('folds dots and underscores to - like the current CLI, keeping alphanumerics', () => {
    expect(encodeClaudeProjectDir('/a/b-c.d_e/2026-05-11')).toBe('-a-b-c-d-e-2026-05-11')
  })

  // The real-world regression: every macOS temp dir carries `s_`, so the old
  // slash-only rule mislocated every demo/smoke/temp-dir run's transcript.
  it('encodes a macOS temp path the way claude 2.1.220 does on disk', () => {
    expect(encodeClaudeProjectDir('/private/var/folders/s_/xy/T/run')).toBe(
      '-private-var-folders-s--xy-T-run',
    )
  })
})

describe('claudeProjectDirCandidates', () => {
  it('offers the current slug first, then the legacy slash-only slug', () => {
    expect(claudeProjectDirCandidates('/var/folders/s_/x')).toEqual([
      '-var-folders-s--x',
      '-var-folders-s_-x',
    ])
  })

  it('collapses to a single candidate when both rules agree', () => {
    expect(claudeProjectDirCandidates('/Users/dev/foo')).toEqual(['-Users-dev-foo'])
  })
})

describe('locateClaudeSessionLog', () => {
  it('returns the path when the predicted JSONL exists', () => {
    const runDir = '/Users/test/canary/logs/runs/r1'
    const sessionId = '01234567-89ab-cdef-0123-456789abcdef'
    const encoded = encodeClaudeProjectDir(runDir)
    const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')

    expect(locateClaudeSessionLog(runDir, sessionId, homeDir)).toBe(jsonl)
  })

  it('returns null when the file is missing', () => {
    expect(locateClaudeSessionLog('/no/such', 'sid', homeDir)).toBeNull()
  })

  it('returns null when sessionId is falsy', () => {
    expect(locateClaudeSessionLog('/some/dir', '', homeDir)).toBeNull()
  })

  // Regression: a run under a macOS temp dir. The predicted slug and the slug
  // claude actually wrote used to disagree, so the log was on disk but the
  // viewer rendered blank.
  it('finds the log under the folded slug for an underscore-bearing runDir', () => {
    const runDir = '/private/var/folders/s_/xy/T/demo/logs/runs/r1'
    const sessionId = 'f4bd4dc1-9d5c-4853-bb3a-d738ab57b5e5'
    const projectDir = path.join(homeDir, '.claude', 'projects', '-private-var-folders-s--xy-T-demo-logs-runs-r1')
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')

    expect(locateClaudeSessionLog(runDir, sessionId, homeDir)).toBe(jsonl)
  })

  it('still finds a log written under the legacy slash-only slug', () => {
    const runDir = '/var/folders/s_/legacy/runs/r2'
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const projectDir = path.join(homeDir, '.claude', 'projects', '-var-folders-s_-legacy-runs-r2')
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')

    expect(locateClaudeSessionLog(runDir, sessionId, homeDir)).toBe(jsonl)
  })

  // Last-resort net: even if claude changes the slug rule again, a pinned
  // session id still resolves.
  it('falls back to a by-id scan when no candidate slug matches', () => {
    const sessionId = 'bbbbbbbb-5555-6666-7777-888888888888'
    const projectDir = path.join(homeDir, '.claude', 'projects', '-some-unrelated-future-slug')
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')

    expect(locateClaudeSessionLog('/totally/other/dir', sessionId, homeDir)).toBe(jsonl)
  })
})

describe('findClaudeLogBySessionId', () => {
  it('returns null when sessionId is falsy', () => {
    expect(findClaudeLogBySessionId('', homeDir)).toBeNull()
  })

  it('returns null when the projects directory does not exist', () => {
    expect(findClaudeLogBySessionId('sid', path.join(homeDir, 'missing-home'))).toBeNull()
  })

  it('scans every project dir and returns the matching session log regardless of encoding', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const base = path.join(homeDir, '.claude', 'projects')
    fs.mkdirSync(path.join(base, '-some-other-proj'), { recursive: true })
    const target = path.join(base, '-folded_slug-proj')
    fs.mkdirSync(target, { recursive: true })
    const jsonl = path.join(target, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')
    expect(findClaudeLogBySessionId(sessionId, homeDir)).toBe(jsonl)
  })

  it('returns null when no project dir holds the session', () => {
    fs.mkdirSync(path.join(homeDir, '.claude', 'projects', '-proj'), { recursive: true })
    expect(findClaudeLogBySessionId('no-such-session', homeDir)).toBeNull()
  })

  it('finds the newest Claude session for a run directory without a sidecar id', () => {
    const runDir = '/Users/test/canary/logs/runs/r1'
    const encoded = encodeClaudeProjectDir(runDir)
    const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
    fs.mkdirSync(projectDir, { recursive: true })
    const older = path.join(projectDir, '01234567-89ab-cdef-0123-456789abcdef.jsonl')
    const newer = path.join(projectDir, 'fedcba98-7654-3210-fedc-ba9876543210.jsonl')
    fs.writeFileSync(older, '')
    fs.writeFileSync(newer, '')
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'ignore me')
    fs.utimesSync(older, new Date('2026-05-10T00:00:00.000Z'), new Date('2026-05-10T00:00:00.000Z'))
    fs.utimesSync(newer, new Date('2026-05-11T00:00:00.000Z'), new Date('2026-05-11T00:00:00.000Z'))

    expect(locateLatestClaudeSessionLog(runDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: 'fedcba98-7654-3210-fedc-ba9876543210',
      logPath: newer,
    })
  })

  // No session id to fall back on here, so both slugs must be scanned — and a
  // run straddling a CLI upgrade legitimately has logs under each.
  it('picks the newest log across both the folded and legacy slugs', () => {
    const runDir = '/var/folders/s_/straddle/runs/r3'
    const base = path.join(homeDir, '.claude', 'projects')
    const foldedDir = path.join(base, '-var-folders-s--straddle-runs-r3')
    const legacyDir = path.join(base, '-var-folders-s_-straddle-runs-r3')
    fs.mkdirSync(foldedDir, { recursive: true })
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacyLog = path.join(legacyDir, '11111111-1111-1111-1111-111111111111.jsonl')
    const foldedLog = path.join(foldedDir, '22222222-2222-2222-2222-222222222222.jsonl')
    fs.writeFileSync(legacyLog, '')
    fs.writeFileSync(foldedLog, '')
    fs.utimesSync(legacyLog, new Date('2026-04-08T00:00:00.000Z'), new Date('2026-04-08T00:00:00.000Z'))
    fs.utimesSync(foldedLog, new Date('2026-08-04T00:00:00.000Z'), new Date('2026-08-04T00:00:00.000Z'))

    expect(locateLatestClaudeSessionLog(runDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: '22222222-2222-2222-2222-222222222222',
      logPath: foldedLog,
    })
  })

  it('keeps the newest mtime entry even when iterated after an older entry', () => {
    const runDir = '/Users/test/canary/logs/runs/r2'
    const encoded = encodeClaudeProjectDir(runDir)
    const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
    fs.mkdirSync(projectDir, { recursive: true })
    // Names ordered so that the NEWER-mtime file is iterated first (a* before z*).
    const newer = path.join(projectDir, 'aaaaaaaa-89ab-cdef-0123-456789abcdef.jsonl')
    const older = path.join(projectDir, 'zzzzzzzz-7654-3210-fedc-ba9876543210.jsonl')
    fs.writeFileSync(newer, '')
    fs.writeFileSync(older, '')
    fs.utimesSync(newer, new Date('2026-05-12T00:00:00.000Z'), new Date('2026-05-12T00:00:00.000Z'))
    fs.utimesSync(older, new Date('2026-05-10T00:00:00.000Z'), new Date('2026-05-10T00:00:00.000Z'))

    expect(locateLatestClaudeSessionLog(runDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: 'aaaaaaaa-89ab-cdef-0123-456789abcdef',
      logPath: newer,
    })
  })

  it('returns null when no Claude project log directory exists for the run', () => {
    expect(locateLatestClaudeSessionLog('/no/such/run', homeDir)).toBeNull()
  })

  it('skips empty, directory, and unreadable Claude session entries', () => {
    const runDir = '/Users/test/canary/logs/runs/r1'
    const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(runDir))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.jsonl'), '')
    fs.mkdirSync(path.join(projectDir, 'directory.jsonl'))
    const unreadable = path.join(projectDir, 'unreadable.jsonl')
    fs.writeFileSync(unreadable, '')
    const expected = path.join(projectDir, 'valid.jsonl')
    fs.writeFileSync(expected, '')
    const originalStatSync = fs.statSync
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((candidate) => {
      if (candidate === unreadable) throw new Error('cannot stat')
      return originalStatSync(candidate as fs.PathLike)
    })

    try {
      expect(locateLatestClaudeSessionLog(runDir, homeDir)).toEqual({
        agent: 'claude',
        sessionId: 'valid',
        logPath: expected,
      })
    } finally {
      statSpy.mockRestore()
    }
  })
})

describe('locateLatestSessionLogForAgent', () => {
  it('dispatches to the selected agent locator', () => {
    const runDir = '/Users/test/run-dispatch'
    const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(runDir))
    fs.mkdirSync(projectDir, { recursive: true })
    const claudeLog = path.join(projectDir, 'sid-claude.jsonl')
    fs.writeFileSync(claudeLog, '')

    expect(locateLatestSessionLogForAgent('claude', runDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: 'sid-claude',
      logPath: claudeLog,
    })
    expect(locateLatestSessionLogForAgent('codex', runDir, homeDir)).toBeNull()
  })
})
