import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDraftStageSessionRef } from '../lib/draft-agent-session'

let tmpDir: string
let draftDir: string
let homeDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-stream-'))
  draftDir = path.join(tmpDir, 'draft')
  homeDir = path.join(tmpDir, 'home')
  fs.mkdirSync(draftDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveDraftStageSessionRef', () => {
  it('refuses a saved ref when its log predates the draft stage spawn', () => {
    const logPath = path.join(tmpDir, 'stale.jsonl')
    fs.writeFileSync(logPath, '{}\n')
    fs.utimesSync(logPath, new Date('2026-05-15T23:59:00.000Z'), new Date('2026-05-15T23:59:00.000Z'))

    const resolved = resolveDraftStageSessionRef({
      ref: { agent: 'claude', sessionId: 'old', logPath },
      draftDir,
      spawnedAt: '2026-05-16T00:00:00.000Z',
    })

    expect(resolved).toBeNull()
  })

  it('discovers only codex sessions for the same draft dir at or after spawnedAt', () => {
    writeCodexSession({
      id: 'old-session',
      cwd: draftDir,
      timestamp: '2026-05-15T23:59:00.000Z',
    })
    writeCodexSession({
      id: 'wrong-draft',
      cwd: path.join(tmpDir, 'other-draft'),
      timestamp: '2026-05-16T00:01:00.000Z',
    })
    const freshPath = writeCodexSession({
      id: 'fresh-session',
      cwd: draftDir,
      timestamp: '2026-05-16T00:02:00.000Z',
    })

    const resolved = resolveDraftStageSessionRef({
      agent: 'codex',
      draftDir,
      spawnedAt: '2026-05-16T00:00:00.000Z',
      homeDir,
    })

    expect(resolved).toEqual({ agent: 'codex', sessionId: 'fresh-session', logPath: freshPath })
  })
})

function writeCodexSession(input: { id: string; cwd: string; timestamp: string }): string {
  const d = new Date(input.timestamp)
  const dir = path.join(
    homeDir,
    '.codex',
    'sessions',
    String(d.getUTCFullYear()).padStart(4, '0'),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  )
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, `rollout-${input.timestamp}-${input.id}.jsonl`)
  fs.writeFileSync(logPath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: input.id,
      cwd: input.cwd,
      timestamp: input.timestamp,
    },
  })}\n`)
  return logPath
}
