import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { captureExecutionEvidence } from './agents'
import { json, write } from './files'
import type { Attempt, StudyManifest } from './types'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it.each([false, true])('captures the pinned Claude session under an opaque project slug (stale sidecar path: %s)', (stale) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-session-')); roots.push(root)
  const config = path.join(root, 'relocated-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
  const cwd = path.join(root, 'attempt/logs/runs/repair')
  const logPath = path.join(config, 'projects', 'shortened-project-opaque-hash', 'parent.jsonl')
  const raw = JSON.stringify({ type: 'assistant', sessionId: 'parent', isSidechain: false,
    message: { id: 'message', model: 'fixture', content: [], usage: {
      input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    } } }) + '\n'
  write(logPath, raw)
  json(path.join(cwd, 'agent-session.json'), { activeAgent: 'claude', sessions: {
    claude: { agent: 'claude', sessionId: 'parent', logPath: stale ? path.join(root, 'obsolete.jsonl') : logPath },
  } })
  const output = path.join(root, 'evidence')
  const manifest = { pins: { claude: { model: 'fixture', effort: 'high' } } } as StudyManifest
  const attempt = { agent: 'claude', variant: { diagnosisPolicy: 'parent-only' } } as Attempt
  const result = captureExecutionEvidence(manifest, attempt, cwd, '2026-01-01T00:00:00Z', output)
  expect(result.usage).toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(result.attribution.issues).toEqual([])
  expect(result.attribution.sessions).toMatchObject([{ sessionId: 'parent', role: 'primary' }])
  expect(fs.readFileSync(path.join(output, 'sessions/parent/session.jsonl'), 'utf8')).toBe(raw)
  expect(fs.readFileSync(path.join(output, 'session.jsonl'), 'utf8')).toBe(raw)
})

it('keeps usage unknown when the pinned Claude transcript is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-session-')); roots.push(root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'empty-config'))
  const cwd = path.join(root, 'run')
  json(path.join(cwd, 'agent-session.json'), { agent: 'claude', sessionId: 'missing', logPath: path.join(root, 'missing.jsonl') })
  const manifest = { pins: { claude: { model: 'fixture', effort: 'high' } } } as StudyManifest
  const result = captureExecutionEvidence(manifest, { agent: 'claude' } as Attempt, cwd, '2026-01-01T00:00:00Z', path.join(root, 'evidence'))
  expect(result.usage).toBeNull()
  expect(result.attribution.missingSessions).toContain('missing')
})
