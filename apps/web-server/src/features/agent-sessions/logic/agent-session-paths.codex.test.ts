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
