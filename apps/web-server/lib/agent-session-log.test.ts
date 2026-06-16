import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  encodeClaudeProjectDir,
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
  writeFullSessionTranscript,
  selectAgentSessionRef,
} from './agent-session-log'

let homeDir: string

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-home-')))
})

afterEach(() => {
  try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('encodeClaudeProjectDir', () => {
  it('replaces every / with - so /Users/dev/foo becomes -Users-dev-foo', () => {
    expect(encodeClaudeProjectDir('/Users/dev/foo')).toBe('-Users-dev-foo')
  })

  it('preserves dots, hyphens, and underscores', () => {
    expect(encodeClaudeProjectDir('/a/b-c.d_e/2026-05-11')).toBe('-a-b-c.d_e-2026-05-11')
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

describe('agent session ref file parsing', () => {
  it('reads the legacy single-session shape', () => {
    const parsed = parseAgentSessionRefFile(JSON.stringify({
      agent: 'claude',
      sessionId: 'sid-c',
      logPath: '/tmp/claude.jsonl',
    }))
    expect(parsed).toEqual({
      activeAgent: 'claude',
      sessions: {
        claude: { agent: 'claude', sessionId: 'sid-c', logPath: '/tmp/claude.jsonl' },
      },
    })
    expect(selectAgentSessionRef(parsed!, 'claude')?.sessionId).toBe('sid-c')
  })

  it('stores and selects separate Claude and Codex sessions', () => {
    const parsed = parseAgentSessionRefFile(JSON.stringify({
      activeAgent: 'codex',
      sessions: {
        claude: { agent: 'claude', sessionId: 'sid-c', logPath: '/tmp/claude.jsonl' },
        codex: { agent: 'codex', sessionId: 'sid-x', logPath: '/tmp/codex.jsonl' },
      },
    }))

    expect(selectAgentSessionRef(parsed!)?.sessionId).toBe('sid-x')
    expect(selectAgentSessionRef(parsed!, 'claude')?.sessionId).toBe('sid-c')
    expect(selectAgentSessionRef(parsed!, 'codex')?.sessionId).toBe('sid-x')
  })

  it('rejects malformed ref-file shapes and falls back when preferred refs are absent', () => {
    expect(parseAgentSessionRefFile('not json')).toBeNull()
    expect(parseAgentSessionRefFile('null')).toBeNull()
    expect(parseAgentSessionRefFile(JSON.stringify({
      sessions: {
        claude: { agent: 'codex', sessionId: 'sid', logPath: '/tmp/wrong-agent.jsonl' },
      },
    }))).toBeNull()
    expect(parseAgentSessionRefFile(JSON.stringify({
      agent: 'claude',
      sessionId: 123,
      logPath: '/tmp/claude.jsonl',
    }))).toBeNull()

    const parsed = parseAgentSessionRefFile(JSON.stringify({
      activeAgent: 'claude',
      sessions: {
        codex: { agent: 'codex', sessionId: 'sid-x', logPath: '/tmp/codex.jsonl' },
      },
    }))

    expect(selectAgentSessionRef(parsed!, 'claude')?.sessionId).toBe('sid-x')
  })

  it('selects active-agent and fallback refs across sparse ref files', () => {
    const claude = { agent: 'claude' as const, sessionId: 'sid-c', logPath: '/tmp/claude.jsonl' }
    const codex = { agent: 'codex' as const, sessionId: 'sid-x', logPath: '/tmp/codex.jsonl' }

    expect(selectAgentSessionRef({ activeAgent: 'claude', sessions: { claude, codex } })?.sessionId).toBe('sid-c')
    expect(selectAgentSessionRef({ activeAgent: 'claude', sessions: { codex } })?.sessionId).toBe('sid-x')
    expect(selectAgentSessionRef({ sessions: { claude } })?.sessionId).toBe('sid-c')
    expect(selectAgentSessionRef({ activeAgent: 'codex', sessions: { claude } })?.sessionId).toBe('sid-c')
    expect(selectAgentSessionRef({ sessions: {} })).toBeNull()
  })

  it('falls back when preferred or active refs point at an absent session slot', () => {
    const claude = { agent: 'claude' as const, sessionId: 'sid-c', logPath: '/tmp/claude.jsonl' }
    const codex = { agent: 'codex' as const, sessionId: 'sid-x', logPath: '/tmp/codex.jsonl' }

    expect(selectAgentSessionRef({ sessions: { claude } }, 'codex')).toBe(claude)
    expect(selectAgentSessionRef({ activeAgent: 'claude', sessions: { codex } })).toBe(codex)
  })
})

describe('locateCodexSessionLog', () => {
  function writeCodexSession(opts: {
    yyyy: string
    mm: string
    dd: string
    fileBase: string
    payload: { id: string; cwd: string; timestamp: string }
  }): string {
    const dir = path.join(homeDir, '.codex', 'sessions', opts.yyyy, opts.mm, opts.dd)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${opts.fileBase}.jsonl`)
    const meta = {
      timestamp: opts.payload.timestamp,
      type: 'session_meta',
      payload: opts.payload,
    }
    fs.writeFileSync(file, JSON.stringify(meta) + '\n')
    return file
  }

  it('finds the session whose cwd + timestamp match', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-23-45-aaaa',
      payload: { id: 'sess-aaaa', cwd: runDir, timestamp: '2026-05-11T01:23:45.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-aaaa', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('reads session_meta even when the first JSONL line is larger than 64 KB', () => {
    // Codex 0.130+ embeds the entire base-instructions prompt into the
    // session_meta payload; the first line can run into hundreds of KB. The
    // previous 8 KB buffer truncated the JSON and made every real run look
    // like "no session".
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const padding = 'x'.repeat(150_000)
    const dir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-2026-05-11T01-23-45-bigprompt.jsonl')
    const meta = {
      timestamp: '2026-05-11T01:23:45.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-bigprompt',
        cwd: runDir,
        timestamp: '2026-05-11T01:23:45.000Z',
        base_instructions: { text: padding },
      },
    }
    fs.writeFileSync(file, JSON.stringify(meta) + '\n')

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-bigprompt', logPath: file })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('reads Codex session metadata when the first line has no trailing newline', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const dir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-2026-05-11T01-23-45-nonewline.jsonl')
    fs.writeFileSync(file, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'sess-nonewline', cwd: runDir, timestamp: '2026-05-11T01:23:45.000Z' },
    }))

    expect(locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)).toEqual({
      agent: 'codex',
      sessionId: 'sess-nonewline',
      logPath: file,
    })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('skips sessions started before cycleStartedAt', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-00-00-old',
      payload: { id: 'sess-old', cwd: runDir, timestamp: '2026-05-11T01:00:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T02:00:00.000Z', homeDir)
    expect(ref).toBeNull()

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('skips sessions whose cwd does not match the runDir', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-23-45-other',
      payload: { id: 'sess-other', cwd: '/some/unrelated/dir', timestamp: '2026-05-11T01:23:45.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)
    expect(ref).toBeNull()

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('ignores malformed Codex session metadata while selecting the newest valid match', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-10-00-wrong-type',
      payload: { id: 'sess-wrong-type', cwd: runDir, timestamp: '2026-05-11T01:10:00.000Z' },
    })
    const malformedDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-12-00-not-meta.jsonl'), JSON.stringify({ type: 'event_msg' }) + '\n')
    fs.writeFileSync(path.join(malformedDir, 'notes.txt'), 'not a session')
    fs.symlinkSync(
      path.join(malformedDir, 'missing-target.jsonl'),
      path.join(malformedDir, 'rollout-2026-05-11T01-12-30-dangling.jsonl'),
    )
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-13-00-bad-payload.jsonl'), JSON.stringify({
      type: 'session_meta',
      payload: { id: 123, cwd: runDir, timestamp: '2026-05-11T01:13:00.000Z' },
    }) + '\n')
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-14-00-bad-json.jsonl'), '{not-json\n')
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-20-00-newest',
      payload: { id: 'sess-newest', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-newest', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('keeps the newest Codex session when an older match is scanned later', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: '000-newer',
      payload: { id: 'sess-newer', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: '999-older',
      payload: { id: 'sess-older', cwd: runDir, timestamp: '2026-05-11T01:10:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-newer', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('ignores close errors while reading Codex session metadata', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-20-00-close-error',
      payload: { id: 'sess-close-error', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {
      throw new Error('close failed')
    })
    try {
      const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
      expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-close-error', logPath: expected })
    } finally {
      closeSpy.mockRestore()
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('returns null when the Codex sessions root is missing', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    expect(locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)).toBeNull()
    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('crosses UTC date boundaries (scans next day too)', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '12',
      fileBase: 'rollout-2026-05-12T00-30-00-next-day',
      payload: { id: 'sess-next', cwd: runDir, timestamp: '2026-05-12T00:30:00.000Z' },
    })

    // Cycle started late on the 11th; session ended up in the 12th's bucket.
    const ref = locateCodexSessionLog(runDir, '2026-05-11T23:50:00.000Z', homeDir)
    expect(ref?.logPath).toBe(expected)

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns null when cycleStartedAt is unparseable', () => {
    expect(locateCodexSessionLog('/some/dir', 'not-a-date', homeDir)).toBeNull()
  })

  it('finds the newest matching Codex session without a cycle timestamp', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '10',
      fileBase: 'rollout-2026-05-10T20-00-00-old',
      payload: { id: 'sess-old', cwd: runDir, timestamp: '2026-05-10T20:00:00.000Z' },
    })
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-20-00-newest',
      payload: { id: 'sess-newest', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-30-00-other-cwd',
      payload: { id: 'sess-other', cwd: '/some/unrelated/dir', timestamp: '2026-05-11T01:30:00.000Z' },
    })

    expect(locateLatestCodexSessionLog(runDir, homeDir)).toEqual({
      agent: 'codex',
      sessionId: 'sess-newest',
      logPath: expected,
    })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('skips invalid latest Codex entries while scanning newest-first buckets', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const dir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'zz-not-jsonl.txt'), 'ignore')
    fs.writeFileSync(path.join(dir, 'zy-bad-timestamp.jsonl'), JSON.stringify({
      type: 'session_meta',
      payload: { id: 'bad-ts', cwd: runDir, timestamp: 'not-a-date' },
    }) + '\n')
    fs.writeFileSync(path.join(dir, 'zx-no-meta.jsonl'), JSON.stringify({ type: 'event_msg' }) + '\n')
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'aa-valid',
      payload: { id: 'sess-valid', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })

    expect(locateLatestCodexSessionLog(runDir, homeDir)).toEqual({
      agent: 'codex',
      sessionId: 'sess-valid',
      logPath: expected,
    })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns null when Codex metadata files are empty or cannot be opened', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const dir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), '')
    fs.symlinkSync(path.join(dir, 'missing-target.jsonl'), path.join(dir, 'dangling.jsonl'))

    expect(locateLatestCodexSessionLog(runDir, homeDir)).toBeNull()

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
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

describe('locateMostRecentAgentSessionRef', () => {
  function writeClaudeSession(runDir: string, sessionId: string, mtime: Date): string {
    const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(runDir))
    fs.mkdirSync(projectDir, { recursive: true })
    const file = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(file, '')
    fs.utimesSync(file, mtime, mtime)
    return file
  }

  function writeCodexSessionWithMtime(
    runDir: string,
    yyyy: string,
    mm: string,
    dd: string,
    sessionId: string,
    mtime: Date,
  ): string {
    const dir = path.join(homeDir, '.codex', 'sessions', yyyy, mm, dd)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-${yyyy}-${mm}-${dd}T00-00-00-${sessionId}.jsonl`)
    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: mtime.toISOString(),
        type: 'session_meta',
        payload: { id: sessionId, cwd: runDir, timestamp: mtime.toISOString() },
      }) + '\n',
    )
    fs.utimesSync(file, mtime, mtime)
    return file
  }

  it('returns null when neither agent has a log for the run', () => {
    expect(locateMostRecentAgentSessionRef('/no/such/run', homeDir)).toBeNull()
  })

  it('returns claude when only claude has a log', () => {
    const runDir = '/Users/test/run-claude-only'
    const logPath = writeClaudeSession(runDir, 'sid-claude', new Date('2026-05-11T00:00:00Z'))
    expect(locateMostRecentAgentSessionRef(runDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: 'sid-claude',
      logPath,
    })
  })

  it('returns codex when only codex has a log', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const logPath = writeCodexSessionWithMtime(
      runDir,
      '2026',
      '05',
      '11',
      'sid-codex',
      new Date('2026-05-11T00:00:00Z'),
    )
    expect(locateMostRecentAgentSessionRef(runDir, homeDir)).toEqual({
      agent: 'codex',
      sessionId: 'sid-codex',
      logPath,
    })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns codex when its log is newer than claude\'s', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeClaudeSession(runDir, 'sid-claude', new Date('2026-05-11T00:00:00Z'))
    const codexLog = writeCodexSessionWithMtime(
      runDir,
      '2026',
      '05',
      '12',
      'sid-codex',
      new Date('2026-05-12T01:34:00Z'),
    )

    const ref = locateMostRecentAgentSessionRef(runDir, homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sid-codex', logPath: codexLog })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns claude when its log is newer than codex\'s', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const claudeLog = writeClaudeSession(runDir, 'sid-claude', new Date('2026-05-12T02:00:00Z'))
    writeCodexSessionWithMtime(
      runDir,
      '2026',
      '05',
      '11',
      'sid-codex',
      new Date('2026-05-11T00:00:00Z'),
    )

    const ref = locateMostRecentAgentSessionRef(runDir, homeDir)
    expect(ref).toEqual({ agent: 'claude', sessionId: 'sid-claude', logPath: claudeLog })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('falls back to codex when the latest Claude file disappears before stat', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const claudeLog = writeClaudeSession(runDir, 'sid-claude', new Date('2026-05-12T02:00:00Z'))
    const codexLog = writeCodexSessionWithMtime(
      runDir,
      '2026',
      '05',
      '11',
      'sid-codex',
      new Date('2026-05-11T00:00:00Z'),
    )
    const originalStatSync = fs.statSync
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((candidate) => {
      if (candidate === claudeLog) throw new Error('gone')
      return originalStatSync(candidate as fs.PathLike)
    })

    try {
      expect(locateMostRecentAgentSessionRef(runDir, homeDir)).toEqual({
        agent: 'codex',
        sessionId: 'sid-codex',
        logPath: codexLog,
      })
    } finally {
      statSpy.mockRestore()
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('prefers claude on an mtime tie to keep single-agent runs stable', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const same = new Date('2026-05-11T12:00:00Z')
    const claudeLog = writeClaudeSession(runDir, 'sid-claude', same)
    writeCodexSessionWithMtime(runDir, '2026', '05', '11', 'sid-codex', same)

    const ref = locateMostRecentAgentSessionRef(runDir, homeDir)
    expect(ref?.agent).toBe('claude')
    expect(ref?.logPath).toBe(claudeLog)

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('falls back to claude when the latest Codex file disappears before stat', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const claudeLog = writeClaudeSession(runDir, 'sid-claude', new Date('2026-05-11T00:00:00Z'))
    const codexLog = writeCodexSessionWithMtime(
      runDir,
      '2026',
      '05',
      '11',
      'sid-codex',
      new Date('2026-05-12T00:00:00Z'),
    )
    const originalStatSync = fs.statSync
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((candidate) => {
      if (candidate === codexLog) throw new Error('gone')
      return originalStatSync(candidate as fs.PathLike)
    })

    try {
      expect(locateMostRecentAgentSessionRef(runDir, homeDir)).toEqual({
        agent: 'claude',
        sessionId: 'sid-claude',
        logPath: claudeLog,
      })
    } finally {
      statSpy.mockRestore()
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})

describe('loadAgentSessionLog (claude)', () => {
  function writeClaudeLog(lines: object[]): string {
    const file = path.join(homeDir, 'claude.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('normalizes a user string message + assistant text + tool_use + tool_result', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: '2026-05-11T07:00:00.000Z',
        message: { content: '@/path/to/prompt.md' },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-11T07:00:01.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: "I'll read the index." },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-11T07:00:02.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
          ],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: '2026-05-11T07:00:00.000Z', text: '@/path/to/prompt.md' },
      { kind: 'assistant-thinking', timestamp: '2026-05-11T07:00:01.000Z', text: 'pondering' },
      { kind: 'assistant-message', timestamp: '2026-05-11T07:00:01.000Z', text: "I'll read the index." },
      { kind: 'tool-call', timestamp: '2026-05-11T07:00:01.000Z', toolId: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
      { kind: 'tool-result', timestamp: '2026-05-11T07:00:02.000Z', toolId: 'toolu_1', output: 'file body' },
    ])
  })

  it('defaults malformed Claude assistant tool_use identifiers', () => {
    const file = writeClaudeLog([
      {
        type: 'assistant',
        timestamp: 't',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'thinking', thinking: '   ' },
            { type: 'tool_use', id: 123, name: null, input: { path: 'x' } },
          ],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: 't', toolId: '', name: '', input: { path: 'x' } },
    ])
  })

  it('skips Claude assistant records whose content is not an array', () => {
    const file = writeClaudeLog([
      {
        type: 'assistant',
        timestamp: 't',
        message: { content: 'not-array' },
      },
      {
        type: 'assistant',
        timestamp: 't',
        message: {
          content: [{ type: 'text', text: 'real text' }],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'assistant-message', timestamp: 't', text: 'real text' },
    ])
  })

  it('handles tool_result content that is an array of text/image blocks', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'image' },
                { type: 'text', text: 'line two' },
              ],
              is_error: true,
            },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_2', output: 'line one\n[image]\nline two', isError: true },
    ])
  })

  it('handles non-string Claude tool_result content without output text', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_object', content: { structured: true } },
            { type: 'tool_result', tool_use_id: 'toolu_image', content: [{ type: 'image' }, null] },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_object', output: '' },
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_image', output: '[image]' },
    ])
  })

  it('defaults malformed Claude tool_result identifiers and preserves false errors as non-error results', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 123, content: 'ok', is_error: false },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: '', output: 'ok' },
    ])
  })

  it('normalizes non-empty user text blocks in array content', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'text', text: 'review this plan' },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'review this plan' },
    ])
  })

  it('skips metadata-only event types and malformed lines', () => {
    const file = path.join(homeDir, 'claude.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'last-prompt' }),
        JSON.stringify({ type: 'permission-mode' }),
        JSON.stringify({ type: 'file-history-snapshot' }),
        JSON.stringify(null),
        'not-json-at-all',
        '',
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: '   ' } }),
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: 123 } }),
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'hi' } }),
      ].join('\n'),
    )
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'hi' },
    ])
  })
})

describe('renderAgentSessionContext', () => {
  it('renders normalized prior-session events into a compact text block', () => {
    const file = path.join(homeDir, 'claude-context.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-11T07:00:00.000Z',
        message: { content: 'please inspect the fallback path' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-11T07:01:00.000Z',
        message: { content: [{ type: 'text', text: 'The issue is in the CNS base URL split.' }] },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-1',
      logPath: file,
    })

    expect(rendered).toContain('Previous claude session sid-1:')
    expect(rendered).toContain('USER: please inspect the fallback path')
    expect(rendered).toContain('ASSISTANT: The issue is in the CNS base URL split.')
  })

  it('returns an empty string when the referenced session log cannot be read', () => {
    expect(renderAgentSessionContext({
      agent: 'codex',
      sessionId: 'missing',
      logPath: '/no/such.jsonl',
    })).toBe('')
  })

  it('renders thinking, tool calls, tool errors, and truncates long context', () => {
    const file = path.join(homeDir, 'claude-context-tools.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'assistant',
        timestamp: 't1',
        message: {
          content: [
            { type: 'thinking', thinking: '  many   details  ' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: 't2',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(1_400), is_error: true },
          ],
        },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-tools',
      logPath: file,
    }, 260)

    expect(rendered).toContain('THINKING: many details')
    expect(rendered).toContain('TOOL CALL Read: {"file_path":"/tmp/a.txt"}')
    expect(rendered).toContain('[Previous session context truncated — full transcript:')
    // Even when truncated, the receiving agent is pointed at the full transcript.
    const transcript = file.replace(/\.jsonl$/, '.transcript.txt')
    expect(rendered).toContain(transcript)
  })

  it('points at a full transcript (envelope stripped, uncapped) even when not truncated', () => {
    const file = path.join(homeDir, 'claude-context-pointer.jsonl')
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: 't1',
      message: { content: [{ type: 'text', text: 'short reply' }] },
    }) + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-pointer',
      logPath: file,
    })

    const transcript = path.join(homeDir, 'claude-context-pointer.transcript.txt')
    expect(rendered).toContain('ASSISTANT: short reply')
    expect(rendered).toContain(`[Full session transcript (untruncated): ${transcript}]`)
    expect(rendered).not.toContain('context truncated')
    // The transcript file is materialized on disk with the full content.
    expect(fs.existsSync(transcript)).toBe(true)
    expect(fs.readFileSync(transcript, 'utf-8')).toContain('ASSISTANT: short reply')
  })

  it('writes an uncapped, newline-preserving transcript that drops the JSONL envelope', () => {
    const file = path.join(homeDir, 'claude-context-full.jsonl')
    const longText = 'line one\nline two\n' + 'x'.repeat(5_000)
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: 't1',
      message: { content: [{ type: 'text', text: longText }] },
    }) + '\n')

    const out = writeFullSessionTranscript({ agent: 'claude', sessionId: 'sid-full', logPath: file })
    expect(out).toBe(path.join(homeDir, 'claude-context-full.transcript.txt'))
    const body = fs.readFileSync(out!, 'utf-8')
    // Uncapped (> the 1200-char digest cap) and newlines preserved (not collapsed).
    expect(body.length).toBeGreaterThan(5_000)
    expect(body).toContain('line one\nline two')
  })

  it('renders tool results with and without error markers when timestamps are absent', () => {
    const file = path.join(homeDir, 'claude-context-results.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'failed', is_error: true },
          ],
        },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-results',
      logPath: file,
    })

    expect(rendered).toContain('TOOL RESULT: ok')
    expect(rendered).toContain('TOOL RESULT ERROR: failed')
    expect(rendered).not.toContain('[] TOOL RESULT')
  })

  it('omits empty rendered event lines from prior-session context', () => {
    const file = path.join(homeDir, 'codex-context-empty.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'not-array' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real output' }] } }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'codex',
      sessionId: 'sid-codex',
      logPath: file,
    })

    expect(rendered).toContain('ASSISTANT: real output')
    expect(rendered).not.toContain('not-array')
  })
})

describe('loadAgentSessionLog (codex)', () => {
  function writeCodexLog(lines: object[]): string {
    const file = path.join(homeDir, 'codex.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('normalizes user/assistant messages, function_call, function_call_output', () => {
    const file = writeCodexLog([
      { timestamp: 't1', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'fix the bug' }],
      } },
      { timestamp: 't2', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'on it' }],
      } },
      { timestamp: 't3', type: 'response_item', payload: {
        type: 'function_call', call_id: 'call_1', name: 'exec_command',
        arguments: '{"cmd":"ls"}',
      } },
      { timestamp: 't4', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'call_1',
        output: 'a\nb\nc',
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't1', text: 'fix the bug' },
      { kind: 'assistant-message', timestamp: 't2', text: 'on it' },
      { kind: 'tool-call', timestamp: 't3', toolId: 'call_1', name: 'exec_command', input: { cmd: 'ls' } },
      { kind: 'tool-result', timestamp: 't4', toolId: 'call_1', output: 'a\nb\nc' },
    ])
  })

  it('skips developer messages and the auto-injected environment_context user msg', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>...</permissions instructions>' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/foo</cwd>\n</environment_context>' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'real prompt' }],
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'real prompt' },
    ])
  })

  it('ignores event_msg lines (they duplicate response_item data)', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'assistant-message', timestamp: 't', text: 'hi' },
    ])
  })

  it('preserves the raw arguments string when JSON.parse fails', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'response_item', payload: {
        type: 'function_call', call_id: 'c', name: 'tool',
        arguments: 'not json',
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: 't', toolId: 'c', name: 'tool', input: 'not json' },
    ])
  })

  it('skips empty/machine Codex payloads and defaults malformed tool fields', () => {
    const file = writeCodexLog([
      { timestamp: 123, type: 'response_item' },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: 'not-array',
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '   ' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'tool',
        content: [{ type: 'output_text', text: 'not a chat message' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'reasoning', content: [{ type: 'output_text', text: 'hidden' }],
      } },
      { timestamp: 123, type: 'response_item', payload: {
        type: 'function_call',
        call_id: 42,
        name: null,
        arguments: { ok: true },
      } },
      { timestamp: 456, type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 42,
        output: { lines: 2 },
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'function_call_output',
        output: null,
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [
          { type: 'output_text', text: 'first' },
          { type: 'image', text: 'ignored' },
          { type: 'output_text', text: 'second' },
        ],
      } },
    ])

    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: '', toolId: '', name: '', input: { ok: true } },
      { kind: 'tool-result', timestamp: '', toolId: '', output: '{"lines":2}' },
      { kind: 'tool-result', timestamp: 't', toolId: '', output: '""' },
      { kind: 'assistant-message', timestamp: 't', text: 'first\nsecond' },
    ])
  })
})

describe('loadAgentSessionLog edge cases', () => {
  it('returns [] when the log file is missing', () => {
    expect(loadAgentSessionLog({ agent: 'claude', sessionId: 'x', logPath: '/no/such.jsonl' })).toEqual([])
  })
})

describe('session metadata (model / effort)', () => {
  function writeLog(lines: object[]): string {
    const file = path.join(homeDir, `meta-${lines.length}-${Math.abs(JSON.stringify(lines).length)}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('extracts model + effort from a codex turn_context line', () => {
    const file = writeLog([
      { type: 'session_meta', payload: { id: 's', cwd: '/x', timestamp: 't' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high', summary: 'auto' } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
    })
  })

  it('takes the last codex turn_context when the model/effort changes mid-session', () => {
    const file = writeLog([
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'low' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5-codex', effort: 'high' } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({
      model: 'gpt-5.5-codex',
      effort: 'high',
    })
  })

  it('extracts model from claude assistant lines and leaves effort undefined', () => {
    const file = writeLog([
      { type: 'user', timestamp: 't', message: { content: 'hi' } },
      { type: 'assistant', timestamp: 't', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] } },
    ])
    const meta = loadAgentSessionMeta({ agent: 'claude', sessionId: 's', logPath: file })
    expect(meta.model).toBe('claude-opus-4-8')
    expect(meta.effort).toBeUndefined()
  })

  it('returns empty meta when no model/effort lines are present', () => {
    const file = writeLog([{ type: 'event_msg', payload: { type: 'task_started' } }])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({})
  })

  it('ignores a turn_context whose model/effort are empty strings or non-strings', () => {
    // Each guard is `typeof x === 'string' && x` — empty strings fail the
    // truthiness arm, non-strings fail the typeof arm. Neither sets meta.
    const file = writeLog([
      { type: 'turn_context', payload: { model: '', effort: '' } },
      { type: 'turn_context', payload: { model: 123, effort: 456 } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({})
  })

  it('returns empty meta when the log file is missing', () => {
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 'x', logPath: '/no/such.jsonl' })).toEqual({})
  })

  it('loadAgentSession returns events and meta from a single read', () => {
    const file = writeLog([
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } },
      { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ])
    const { events, meta } = loadAgentSession({ agent: 'codex', sessionId: 's', logPath: file })
    expect(meta).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    expect(events).toEqual([{ kind: 'assistant-message', timestamp: 't', text: 'done' }])
  })
})
