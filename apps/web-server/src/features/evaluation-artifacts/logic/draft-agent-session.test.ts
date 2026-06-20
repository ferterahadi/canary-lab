import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveDraftStageSessionRef } from './draft-agent-session'

const tmpDirs: string[] = []
function mk(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-das-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('resolveDraftStageSessionRef → isSessionFresh', () => {
  it('returns the ref when the log is fresh (no spawnedAt)', () => {
    const dir = mk()
    const logPath = path.join(dir, 'codex.jsonl')
    fs.writeFileSync(logPath, '')
    const ref = { agent: 'codex' as const, sessionId: 'sid', logPath }
    expect(resolveDraftStageSessionRef({ ref, draftDir: dir })).toEqual(ref)
  })

  it('returns null when spawnedAt parses to NaN', () => {
    const dir = mk()
    const logPath = path.join(dir, 'codex.jsonl')
    fs.writeFileSync(logPath, '')
    const ref = { agent: 'codex' as const, sessionId: 'sid', logPath }
    expect(resolveDraftStageSessionRef({ ref, draftDir: dir, spawnedAt: 'nope' })).toBeNull()
  })

  it('returns null when fs.statSync throws while checking freshness', () => {
    const dir = mk()
    const logPath = path.join(dir, 'codex.jsonl')
    fs.writeFileSync(logPath, '')
    const ref = { agent: 'codex' as const, sessionId: 'sid', logPath }
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(
      resolveDraftStageSessionRef({ ref, draftDir: dir, spawnedAt: '2026-05-01T00:00:00.000Z' }),
    ).toBeNull()
  })

  it('returns null when there is no ref and agent is not codex', () => {
    const dir = mk()
    expect(
      resolveDraftStageSessionRef({ agent: 'claude', draftDir: dir, spawnedAt: '2026-05-01T00:00:00.000Z' }),
    ).toBeNull()
  })
})
