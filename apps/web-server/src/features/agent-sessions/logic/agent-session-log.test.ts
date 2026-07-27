import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  encodeClaudeProjectDir,
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

describe('resolveManifestSessionRef', () => {
  it('returns null when sessionRef is undefined', () => {
    expect(resolveManifestSessionRef(undefined, {})).toBeNull()
  })

  it('returns null for a claude ref when sessionId is empty (line 301)', () => {
    expect(resolveManifestSessionRef({ agent: 'claude', sessionId: '' }, {})).toBeNull()
  })

  it('returns null for a codex ref when opts lacks projectRoot (line 305-306)', () => {
    // codex branch requires opts.projectRoot and opts.startedAt; without them → null
    expect(resolveManifestSessionRef(
      { agent: 'codex', sessionId: 'sess-1' },
      { startedAt: '2026-01-01T00:00:00Z' }, // no projectRoot
    )).toBeNull()
  })

  it('returns null for a codex ref when opts lacks startedAt (line 305-306)', () => {
    expect(resolveManifestSessionRef(
      { agent: 'codex', sessionId: 'sess-1' },
      { projectRoot: '/some/project' }, // no startedAt
    )).toBeNull()
  })

  it('returns a claude ref when findClaudeLogBySessionId finds a log (line 303 truthy branch)', () => {
    // Create a real .claude/projects/<encoded-dir>/<sessionId>.jsonl so findClaudeLogBySessionId returns it.
    const sessionId = 'test-session-abc123'
    const runDir = homeDir
    const encoded = encodeClaudeProjectDir(runDir)
    const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
    fs.mkdirSync(projectDir, { recursive: true })
    const logFile = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(logFile, '')
    // Mock os.homedir to return homeDir so findClaudeLogBySessionId scans our temp dir.
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    try {
      const result = resolveManifestSessionRef({ agent: 'claude', sessionId }, {})
      expect(result).toMatchObject({ agent: 'claude', sessionId, logPath: logFile })
    } finally {
      homedirSpy.mockRestore()
    }
  })

  it('calls locateCodexSessionLog when both projectRoot and startedAt are provided (line 306)', () => {
    // Provide both opts → the codex path reaches line 306: return locateCodexSessionLog(...)
    // No Codex sessions exist in homeDir, so locateCodexSessionLog returns null — that's fine;
    // the important thing is that line 306 executes.
    const result = resolveManifestSessionRef(
      { agent: 'codex', sessionId: 'sess-1' },
      { projectRoot: homeDir, startedAt: '2026-01-01T00:00:00.000Z' },
    )
    // locateCodexSessionLog finds nothing in the empty homeDir, so null is returned via line 306.
    expect(result).toBeNull()
  })

  it('returns null for a claude ref when findClaudeLogBySessionId finds no log (line 302-303 null arm)', () => {
    // Spy on readdirSync: throw ENOENT for any .claude path → findClaudeLogBySessionId returns null.
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, opts) => {
      if (String(p).includes('.claude')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return (fs.readdirSync as Function)(p, opts)
    })
    try {
      const result = resolveManifestSessionRef({ agent: 'claude', sessionId: 'sid-abc' }, {})
      expect(result).toBeNull()
    } finally {
      readdirSpy.mockRestore()
    }
  })
})

describe('writeWorkflowAgentRef + resolveWorkflowAgentRef', () => {
  function workflowDir(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wf-')))
  }

  it('returns null when no ref file has been written', () => {
    expect(resolveWorkflowAgentRef(workflowDir(), homeDir)).toBeNull()
  })

  it('creates the sidecar dir when it does not exist yet (orphaned-session regression)', () => {
    // Flight per-stage dirs (flightDir/<stage>) are NOT pre-created by the store,
    // so the ref write must mkdir first — otherwise it ENOENTs, the catch swallows
    // it, and the agent's session is orphaned (blank Activity rail despite a run).
    const stageDir = path.join(workflowDir(), 'scout') // nested, does not exist
    expect(fs.existsSync(stageDir)).toBe(false)
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wf-cwd-')))
    writeWorkflowAgentRef(stageDir, { agent: 'claude', cwd, sessionId: 'sid-scout', spawnedAt: '2026-05-11T01:00:00.000Z' }, homeDir)
    expect(fs.existsSync(path.join(stageDir, 'agent-session.json'))).toBe(true)
    expect(resolveWorkflowAgentRef(stageDir, homeDir)).toEqual({
      agent: 'claude',
      sessionId: 'sid-scout',
      logPath: claudeSessionLogPath(cwd, 'sid-scout', homeDir),
    })
  })

  it('writes a claude ref and resolves it by session id once the log exists', () => {
    const dir = workflowDir()
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wf-cwd-')))
    writeWorkflowAgentRef(dir, { agent: 'claude', cwd, sessionId: 'sid-claude', spawnedAt: '2026-05-11T01:00:00.000Z' }, homeDir)

    // No log on disk yet → falls back to the cwd-derived ref (logPath as written).
    const before = resolveWorkflowAgentRef(dir, homeDir)
    expect(before).toEqual({ agent: 'claude', sessionId: 'sid-claude', logPath: claudeSessionLogPath(cwd, 'sid-claude', homeDir) })

    // Write the log under a DIFFERENT project slug so the by-id scan is what finds it.
    const projDir = path.join(homeDir, '.claude', 'projects', 'some-other-slug')
    fs.mkdirSync(projDir, { recursive: true })
    const logPath = path.join(projDir, 'sid-claude.jsonl')
    fs.writeFileSync(logPath, '{}\n')

    expect(resolveWorkflowAgentRef(dir, homeDir)).toEqual({ agent: 'claude', sessionId: 'sid-claude', logPath })
  })

  it('writes a codex hint and discovers the session by cwd + spawn time', () => {
    const dir = workflowDir()
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wf-cwd-')))
    writeWorkflowAgentRef(dir, { agent: 'codex', cwd, spawnedAt: '2026-05-11T01:00:00.000Z' }, homeDir)

    // No codex session on disk yet → null (the WS keeps polling discoverRef).
    expect(resolveWorkflowAgentRef(dir, homeDir)).toBeNull()

    const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const logPath = path.join(sessionsDir, 'rollout-2026-05-11T01-05-00-bbbb.jsonl')
    fs.writeFileSync(
      logPath,
      JSON.stringify({ timestamp: '2026-05-11T01:05:00.000Z', type: 'session_meta', payload: { id: 'sess-bbbb', cwd, timestamp: '2026-05-11T01:05:00.000Z' } }) + '\n',
    )

    expect(resolveWorkflowAgentRef(dir, homeDir)).toEqual({ agent: 'codex', sessionId: 'sess-bbbb', logPath })

    try { fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('ignores a malformed ref file', () => {
    const dir = workflowDir()
    fs.writeFileSync(path.join(dir, 'agent-session.json'), 'not json')
    expect(resolveWorkflowAgentRef(dir, homeDir)).toBeNull()
  })

  it('returns ref unchanged when logPath is empty (falsy) and agent is claude with no log on disk', () => {
    // Write a legacy-format ref with logPath: '' so ref.logPath is falsy → skips existsSync check
    // and falls through to findClaudeLogBySessionId which returns null → returns ref as-is.
    const dir = workflowDir()
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ agent: 'claude', sessionId: 'sid-empty-path', logPath: '' }),
    )
    const result = resolveWorkflowAgentRef(dir, homeDir)
    // ref.logPath is '' (falsy) → line362 branch0 covered; claude → findClaudeLogBySessionId → null
    expect(result).toEqual({ agent: 'claude', sessionId: 'sid-empty-path', logPath: '' })
  })

  it('returns ref unchanged when logPath is empty and agent is codex (non-claude branch)', () => {
    // Legacy-format codex ref with logPath: '' → ref.logPath is falsy (line362 branch0),
    // then ref.agent !== 'claude' → found = null (line363 branch1) → returns ref.
    const dir = workflowDir()
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ agent: 'codex', sessionId: 'sess-codex-empty', logPath: '' }),
    )
    const result = resolveWorkflowAgentRef(dir, homeDir)
    expect(result).toEqual({ agent: 'codex', sessionId: 'sess-codex-empty', logPath: '' })
  })

  it('returns ref directly when logPath is set and the log file exists at that path (line 362 true branch)', () => {
    const dir = workflowDir()
    const logPath = path.join(dir, 'claude-session.jsonl')
    fs.writeFileSync(logPath, '{}\n')
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ agent: 'claude', sessionId: 'sid-test', logPath }),
    )
    const result = resolveWorkflowAgentRef(dir, homeDir)
    expect(result).toEqual({ agent: 'claude', sessionId: 'sid-test', logPath })
  })

  it('returns null from readCodexDiscoveryHint when codexDiscovery.cwd is not a string', () => {
    // codexDiscovery present but cwd is a number → typeof cwd !== 'string' → returns null (line373).
    // The file also lacks the legacy agent/sessionId/logPath fields, so parseAgentSessionRefFile
    // returns null too → resolveWorkflowAgentRef returns null.
    const dir = workflowDir()
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ codexDiscovery: { cwd: 123, spawnedAt: '2026-01-01T00:00:00Z' } }),
    )
    expect(resolveWorkflowAgentRef(dir, homeDir)).toBeNull()
  })
})
