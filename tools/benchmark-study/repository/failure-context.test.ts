import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readJson, write } from '../files'
import type { Attempt, StudyManifest, UsageAttribution, PolicyAdherence } from '../types'
import { readRepositoryFailureContext, writeRepositoryFailureContext } from './failure-context'
import { renderRepositoryRepairPrompt } from './prompts'
import { reviewCodexChildContext } from './child-context'
import { trackTempDirs } from '../../test-helpers/temp-dir'

const tempDir = trackTempDirs('repository-context-')
function root(): string {
  const directory = tempDir()
  return directory
}
const pin = { model: 'synthetic-model', effort: 'high', version: 'synthetic' }
const diagnostics = [{ title: 'first failure', messages: ['FIRST_DIAGNOSTIC'] }, { title: 'second failure', messages: ['SECOND_DIAGNOSTIC'] }]

it('supplies a stable heal index and one complete child handoff per failure without cross-failure diagnostic context', () => {
  const directory = root()
  const failures = writeRepositoryFailureContext(directory, diagnostics, 'codex', pin)
  expect(readRepositoryFailureContext(directory)).toEqual(failures)
  const index = fs.readFileSync(path.join(directory, 'heal-index.md'), 'utf8')
  for (const [position, failure] of failures.entries()) {
    expect(index).toContain(failure.failureId)
    expect(index).toContain(failure.diagnosticPath)
    expect(index).toContain(failure.childPromptPath)
    expect(readJson(path.join(directory, failure.diagnosticPath))).toEqual({ failureId: failure.failureId, ...diagnostics[position] })
    const child = fs.readFileSync(path.join(directory, failure.childPromptPath), 'utf8')
    expect(child).toContain(diagnostics[position].messages[0])
    expect(child).not.toContain(diagnostics[1 - position].messages[0])
    expect(child).toContain('Do not edit any files')
    expect(child).toContain('hypothesis and a concrete proposed patch')
    expect(child).not.toContain('{{')
  }
  expect(readJson(path.join(directory, 'diagnosis-ledger.json'))).toMatchObject({ failures: [
    { failureId: failures[0].failureId, status: 'unresolved' }, { failureId: failures[1].failureId, status: 'unresolved' },
  ] })
  const other = root()
  expect(writeRepositoryFailureContext(other, diagnostics, 'codex', pin)).toEqual(failures)
  fs.rmSync(path.join(directory, failures[1].diagnosticPath))
  expect(() => readRepositoryFailureContext(directory)).toThrow('missing or incomplete')
  expect(() => writeRepositoryFailureContext(root(), [], 'codex', pin)).toThrow('complete failing diagnostics')
})

it.each(['per-failure', 'parent-only'] as const)('renders %s with the correct policy and explicit fresh-history model pins', (policy) => {
  const directory = root()
  writeRepositoryFailureContext(path.join(directory, 'frozen/diagnosis/codex/independent'), diagnostics, 'codex', pin)
  const manifest = { root: directory, pins: { codex: pin }, repository: { maxChecks: 6 } } as StudyManifest
  const attempt = { agent: 'codex', scenario: 'independent', workflow: 'canary', variant: { diagnosisPolicy: policy } } as Attempt
  const prompt = renderRepositoryRepairPrompt(manifest, attempt)
  expect(prompt).toContain('fork_turns: "none"')
  expect(prompt).toContain('model: "synthetic-model"')
  expect(prompt).toContain('reasoning_effort: "high"')
  expect(prompt).toContain('Fix application source, not tests.')
  expect(prompt).toContain('diagnosis-ledger.json')
  expect(prompt).not.toContain('{{')
  expect(prompt).toContain(policy === 'per-failure' ? 'one read-only' : 'do not spawn diagnosis children')
})

it.each([
  [{ fork_turns: 'all', model: pin.model, reasoning_effort: pin.effort }, 'violation'],
  [{ fork_turns: 'none' }, 'violation'],
  [{ fork_turns: 'none', model: pin.model, reasoning_effort: pin.effort }, 'unknown'],
] as const)('reviews native spawn arguments without claiming full semantic adherence (%j)', (args, status) => {
  const directory = root()
  const raw = [{ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'launch', arguments: JSON.stringify(args) } }]
    .map((entry) => JSON.stringify(entry)).join('\n')
  write(path.join(directory, 'sessions/parent/session.jsonl'), raw)
  const attribution = { sessions: [{ role: 'primary', sessionId: 'parent', evidence: 'sessions/parent' }] } as UsageAttribution
  const adherence: PolicyAdherence = { assigned: 'per-failure', status: 'unknown', childCount: 1, reviewRequired: true, evidence: [] }
  expect(reviewCodexChildContext(directory, pin, attribution, adherence)).toMatchObject({ status, reviewRequired: true })
  expect(readJson(path.join(directory, 'child-context-review.json'))).toMatchObject({ semanticReviewRequired: true })
})

it('renders and reviews the local V1 fresh-history contract without accepting a V2 fork flag as proof', () => {
  const directory = root()
  writeRepositoryFailureContext(path.join(directory, 'frozen/diagnosis/codex/independent'), diagnostics, 'codex', pin)
  const manifest = { root: directory, pins: { codex: pin }, repository: { maxChecks: 6, childAudit: { backend: 'local-v1' } } } as StudyManifest
  const attempt = { agent: 'codex', scenario: 'independent', workflow: 'canary', variant: { diagnosisPolicy: 'per-failure' } } as Attempt
  const prompt = renderRepositoryRepairPrompt(manifest, attempt)
  expect(prompt).toContain('multi_agent_v1.spawn_agent')
  expect(prompt).toContain('fork_context: false')
  expect(prompt).not.toContain('fork_turns: "none"')
  const attribution = { sessions: [{ role: 'primary', sessionId: 'parent', evidence: 'sessions/parent' }] } as UsageAttribution
  const adherence: PolicyAdherence = { assigned: 'per-failure', status: 'unknown', childCount: 1, reviewRequired: true, evidence: [] }
  for (const [args, status] of [[{ fork_context: false, model: pin.model, reasoning_effort: pin.effort }, 'unknown'],
    [{ fork_turns: 'none', model: pin.model, reasoning_effort: pin.effort }, 'violation']] as const) {
    write(path.join(directory, 'sessions/parent/session.jsonl'), JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1', call_id: 'v1-launch', arguments: JSON.stringify(args),
    } }))
    expect(reviewCodexChildContext(directory, pin, attribution, adherence, 'local-v1').status).toBe(status)
  }
})

it('verifies code-mode history pins against its correlated native hook and rejects inherited history', () => {
  const directory = root()
  const input = { fork_context: false, message: 'synthetic handoff', model: pin.model, reasoning_effort: pin.effort }
  write(path.join(directory, 'sessions/parent/session.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CollabAgentToolCall', tool: 'spawn_agent', id: 'exec-native', prompt: input.message, model: pin.model, reasoning_effort: pin.effort } } }))
  const audit = path.join(directory, 'protected-audit.jsonl')
  const attribution = { sessions: [{ sessionId: 'parent', role: 'primary', evidence: 'sessions/parent' }] } as UsageAttribution
  const adherence = { status: 'unknown', reviewRequired: true, evidence: [] } as unknown as PolicyAdherence
  expect(reviewCodexChildContext(directory, pin, attribution, adherence, 'local-v1', audit).status).toBe('violation')
  write(audit, JSON.stringify({ session_id: 'parent', hook_event_name: 'PreToolUse', tool_use_id: 'exec-native', tool_input: input }))
  expect(reviewCodexChildContext(directory, pin, attribution, adherence, 'local-v1', audit).status).toBe('unknown')
  expect(readJson(path.join(directory, 'child-context-review.json'))).toMatchObject({ launches: [{ callId: 'exec-native', forkContext: false }], violations: [] })
  write(audit, JSON.stringify({ session_id: 'parent', hook_event_name: 'PreToolUse', tool_use_id: 'exec-native', tool_input: { ...input, fork_context: true } }))
  expect(reviewCodexChildContext(directory, pin, attribution, adherence, 'local-v1', audit).status).toBe('violation')
})
