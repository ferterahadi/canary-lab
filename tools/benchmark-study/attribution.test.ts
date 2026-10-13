import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { attributeUsage, assessPolicy } from './attribution'
import { auditStudy } from './audit'
import { json, write } from './files'
import { trackTempDirs } from '../test-helpers/temp-dir'

const tempDir = trackTempDirs('study-audit-test-')
const line = (value: object): string => JSON.stringify(value)
const tokens = (input: number, timestamp = '2026-01-01T00:01:00Z'): string => line({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 10, cached_input_tokens: input / 2 } } } })
const meta = (id: string, parent?: string): string => line({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id, thread_source: parent ? 'subagent' : 'user', ...(parent ? { parent_thread_id: parent } : {}) } })
const input = (sessionId: string, raw: string | null) => ({ sessionId, raw, evidence: `sessions/${sessionId}` })
const spawn = line({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'launch' } })

it('attributes by native parentage even when children come first, deduplicates session copies and takes the last cumulative counter', () => {
  const primary = input('parent', [meta('parent'), spawn, tokens(100), tokens(200, '2026-01-01T00:02:00Z')].join('\n'))
  const child = input('child', [meta('child', 'parent'), tokens(50)].join('\n'))
  const result = attributeUsage('codex', [child, primary, input('copy', [meta('parent'), tokens(100)].join('\n'))])
  expect(result.sessions.map((row) => row.role)).toEqual(['diagnosis-child', 'primary'])
  expect(result.total).toEqual({ input: 250, output: 20, cacheRead: 125, cacheWrite: null })
  expect(result.byRole.primary?.input).toBe(200)
  expect(result.byRole['diagnosis-child']?.input).toBe(50)
  expect(result.missingSessions).toEqual([])
})

it('keeps reviewers separate and does not use a reviewer to fill a missing diagnosis child', () => {
  const parent = input('parent', [meta('parent'), spawn, tokens(100)].join('\n'))
  const reviewer = input('review', [line({ type: 'session_meta', payload: { id: 'review', thread_source: 'guardian_review' } }), tokens(20)].join('\n'))
  const result = attributeUsage('codex', [parent, reviewer])
  expect(result.total).toBeNull()
  expect(result.byRole['approval-review']?.input).toBe(20)
  expect(result.missingSessions).toEqual(['parent: 1 uncaptured launch(es)'])
  const rejection = line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'launch', output: 'collab spawn failed: limit' } })
  expect(attributeUsage('codex', [{ ...parent, raw: parent.raw + '\n' + rejection }, reviewer]).total?.input).toBe(120)
})

it('retains missing, unclassified and inconsistent usage as unknown', () => {
  expect(attributeUsage('codex', [input('unknown', tokens(10))]).total).toBeNull()
  const missing = attributeUsage('codex', [input('parent', meta('parent')), input('missing', null)])
  expect(missing.missingSessions).toEqual(['parent', 'missing'])
  expect(missing.total).toBeNull()
  expect(attributeUsage('codex', [input('parent', meta('parent') + '\n' + tokens(-20))]).issues).toContain('Inconsistent native counters: parent')
})

it('deduplicates Claude message IDs across copied logs and uses native sidechain parentage', () => {
  const message = (id: string, sessionId: string, side: boolean, n: number) => line({ type: 'assistant', sessionId, isSidechain: side,
    ...(side ? { agentId: 'child' } : {}), message: { id, usage: { input_tokens: n, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } })
  const result = attributeUsage('claude', [input('parent', message('p', 'parent', false, 10)), input('agent-child', message('c', 'parent', true, 20)), input('agent-child', message('c', 'parent', true, 20))])
  expect(result.sessions).toHaveLength(2)
  expect(result.total).toEqual({ input: 30, output: 4, cacheRead: 6, cacheWrite: 8 })
  expect(result.sessions[1].parentSessionId).toBe('parent')
  expect(assessPolicy('adaptive', result).status).toBe('unknown')
  expect(assessPolicy('parent-only', result).evidence[0]).toContain('escalation')
})

it('audits and copies historical native evidence without rewriting receipts or requiring the source revision', () => {
  const root = tempDir()
  const study = path.join(root, 'historical'); const out = path.join(root, 'audit')
  json(path.join(study, 'study.json'), { schemaVersion: 1, results: [{ id: 'attempt', agent: 'codex', outcome: 'failed', usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: null } }] })
  json(path.join(study, 'attempts/attempt/sessions/index.json'), [{ sessionId: 'parent', evidence: 'sessions/parent' }])
  write(path.join(study, 'attempts/attempt/sessions/parent/session.jsonl'), meta('parent') + '\n' + tokens(100))
  const original = fs.readFileSync(path.join(study, 'study.json'), 'utf8')
  auditStudy(study, out)
  expect(fs.readFileSync(path.join(study, 'study.json'), 'utf8')).toBe(original)
  const result = JSON.parse(fs.readFileSync(path.join(out, 'audit.json'), 'utf8'))
  expect(result.attempts[0]).toMatchObject({ reconciliation: 'matches', outcome: 'failed', timing: null })
  expect(fs.existsSync(path.join(out, result.attempts[0].attribution.sessions[0].evidence))).toBe(true)
  expect(() => auditStudy(study, out)).toThrow('new directory')
})

it('counts code-mode child launches by native receiver ID and flags uncaptured children', () => {
  const nested = line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CollabAgentToolCall', tool: 'spawn_agent', id: 'exec-launch',
    receiver_thread_ids: ['child'], status: 'completed', prompt: 'synthetic task', model: 'synthetic-model', reasoning_effort: 'high' } } })
  const parent = input('parent', [meta('parent'), nested, tokens(100)].join('\n'))
  expect(attributeUsage('codex', [parent]).missingSessions).toContain('child')
  const child = input('child', [meta('child', 'parent'), tokens(50)].join('\n'))
  expect(attributeUsage('codex', [parent, child]).total?.input).toBe(150)
  expect(attributeUsage('codex', [parent, child]).missingSessions).toEqual([])
})
