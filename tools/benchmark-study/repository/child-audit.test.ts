import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { json, readJson, sha, write } from '../files'
import type { Attempt, StudyManifest, UsageAttribution, PolicyAdherence } from '../types'
import { writeRepositoryFailureContext } from './failure-context'
import { freezeChildAudit, prepareChildAudit, reviewChildAudit } from './child-audit'
import { freezeChildReadGuard } from './child-read-guard'
import { recoverWorkerEvidence } from '../worker-evidence'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function setup(backend?: 'local-v1') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'child-audit-')))
  roots.push(root)
  const authFile = path.join(root, 'synthetic-auth.json')
  json(authFile, { auth_mode: 'chatgpt', tokens: { account_id: 'synthetic-account' } })
  const catalogFile = path.join(root, 'synthetic-catalog.json')
  const model = { slug: 'synthetic-model', multi_agent_version: 'v2', context_window: 1234 }
  json(catalogFile, { models: [model] })
  const attempt = { id: 'synthetic-attempt', agent: 'codex', scenario: 'independent', variant: { diagnosisPolicy: 'per-failure' } } as Attempt
  const manifest = { root, repository: { childAudit: { authFile, accountIdentitySha256: sha('synthetic-account'),
    ...(backend ? { backend, catalogFile, catalogModel: model.slug, catalogModelSha256: sha(JSON.stringify(model)) } : {}) } },
    pins: { codex: { model: 'synthetic-model', effort: 'high' } },
    codexToolArgs: ['--disable', 'hooks', '--disable', 'apps', '-c', 'mcp_servers.synthetic.enabled=false'] } as StudyManifest
  const directory = path.join(root, 'attempts', attempt.id)
  const failures = writeRepositoryFailureContext(directory, [{ title: 'one', messages: ['FIRST'] }, { title: 'two', messages: ['SECOND'] }], 'codex', manifest.pins.codex)
  freezeChildAudit(root, manifest.repository!.childAudit)
  freezeChildReadGuard(root)
  const audit = prepareChildAudit(manifest, attempt, directory)
  const attribution = { missingSessions: [], issues: [], sessions: [{ role: 'primary', sessionId: 'parent', evidence: 'sessions/parent' }], total: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 } } as UsageAttribution
  const adherence = { assigned: 'per-failure', status: 'unknown', childCount: 2, reviewRequired: true, evidence: [] } as PolicyAdherence
  return { root, directory, manifest, attempt, failures, audit, attribution, adherence }
}

function invoke(script: string, output: string, cwd: string, event: object) {
  return spawnSync(process.execPath, [script, output, cwd], { input: JSON.stringify({ cwd, session_id: 'parent', ...event }), encoding: 'utf8' })
}

it('uses an isolated config and an auth reference without copying credentials or inherited hooks', () => {
  const { manifest, audit } = setup()
  expect(fs.readlinkSync(path.join(audit.home, 'auth.json'))).toBe(manifest.repository!.childAudit!.authFile)
  expect(audit.args).toEqual(['--disable', 'apps', '--dangerously-bypass-hook-trust'])
  expect(fs.readFileSync(path.join(audit.home, 'config.toml'), 'utf8')).not.toContain('synthetic-account')
  expect(readJson(path.join(audit.home, 'hooks.json'))).toMatchObject({ hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] },
    { matcher: '.*', hooks: [{ command: expect.stringContaining('child-read-guard.cjs') }] }],
  SubagentStart: [{ hooks: [{ command: expect.stringContaining('child-read-guard.cjs') }] }] } })
  const hooks = readJson<{ hooks: { PreToolUse: Array<{ matcher: string }> } }>(path.join(audit.home, 'hooks.json'))
  const matcher = new RegExp(hooks.hooks.PreToolUse[0].matcher)
  for (const name of ['spawn_agent', 'Agent', 'collaborationspawn_agent', 'collaboration.send_message', 'multi_agent_v1send_input']) expect(matcher.test(name)).toBe(true)
  expect(matcher.test('Bash')).toBe(false)
})

it('captures actual native-hook messages, correlates both phases and checks each frozen failure handoff', () => {
  const { root, directory, manifest, attempt, failures, audit, attribution, adherence } = setup()
  const script = path.join(root, 'frozen/audit/child-audit-hook.cjs')
  expect(invoke(script, audit.output, directory, { hook_event_name: 'SessionStart' }).status).toBe(0)
  const calls = failures.map((failure, index) => {
    const input = { fork_turns: 'none', model: 'synthetic-model', reasoning_effort: 'high', message: fs.readFileSync(path.join(directory, failure.childPromptPath), 'utf8') }
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) expect(invoke(script, audit.output, directory,
      { hook_event_name, tool_name: 'spawn_agent', tool_use_id: `call-${index}`, tool_input: input }).status).toBe(0)
    return { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: `call-${index}`, arguments: JSON.stringify({ ...input, message: 'gAAAA_ENCRYPTED_NATIVE_LOG' }) } }
  })
  write(path.join(directory, 'sessions/parent/session.jsonl'), calls.map((row) => JSON.stringify(row)).join('\n'))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('unknown')
  expect(readJson(path.join(directory, 'child-assignment-review.json'))).toMatchObject({ violations: [], comparisons: [
    { failureId: failures[0].failureId, match: 'exact' }, { failureId: failures[1].failureId, match: 'exact' },
  ] })
  fs.writeFileSync(audit.output, fs.readFileSync(audit.output, 'utf8').split('\n').filter((line) => !line.includes('PostToolUse')).join('\n'))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('violation')
})

it('denies an encrypted hook input and rejects a forged working directory', () => {
  const { root, directory, audit } = setup()
  const script = path.join(root, 'frozen/audit/child-audit-hook.cjs')
  const denied = invoke(script, audit.output, directory, { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_input: { message: 'gAAAA_ENCRYPTED' } })
  expect(JSON.parse(denied.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  expect(invoke(script, audit.output, directory, { cwd: root }).status).toBe(2)
})

it('preserves the audited policy violation when worker recovery restores native usage', () => {
  const { attempt, attribution, adherence } = setup()
  const reviewed = { ...adherence, status: 'violation' as const, evidence: ['Exact child assignment audit failed'] }
  const result = recoverWorkerEvidence({ status: 'finished', reason: '', usage: null, adherence: reviewed, testExecutions: 1 }, attempt, attribution)
  expect(result.adherence).toEqual(reviewed)
  expect(result.usage).toEqual(attribution.total)
  expect(recoverWorkerEvidence({ status: 'infrastructure-error', reason: 'capture interrupted', usage: null, testExecutions: null }, attempt, attribution).adherence?.status).toBe('unknown')
})

it('pins local V1 by changing only native catalog delegation metadata and rejects later source metadata drift', () => {
  const { root, manifest, audit, attempt, directory } = setup('local-v1')
  const original = readJson<Record<string, unknown>>(path.join(root, 'frozen/audit/original-model.json'))
  expect(readJson(path.join(root, 'frozen/audit/model-catalog.json'))).toEqual({ models: [{ ...original, multi_agent_version: 'v1' }] })
  expect(fs.readFileSync(path.join(audit.home, 'config.toml'), 'utf8')).toContain('multi_agent_v2 = false')
  json(manifest.repository!.childAudit!.catalogFile!, { models: [{ ...original, context_window: 9999 }] })
  expect(() => prepareChildAudit(manifest, attempt, directory)).toThrow('catalog metadata changed')
})

it('audits explicit fresh-history V1 launch payloads against their actual frozen assignments', () => {
  const { root, directory, manifest, attempt, failures, audit, attribution, adherence } = setup('local-v1')
  const script = path.join(root, 'frozen/audit/child-audit-hook.cjs')
  invoke(script, audit.output, directory, { hook_event_name: 'SessionStart' })
  const calls = failures.map((failure, index) => {
    const input = { fork_context: false, model: 'synthetic-model', reasoning_effort: 'high', message: fs.readFileSync(path.join(directory, failure.childPromptPath), 'utf8') }
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) invoke(script, audit.output, directory,
      { hook_event_name, tool_name: 'spawn_agent', tool_use_id: `v1-${index}`, tool_input: input })
    return { type: 'response_item', payload: { type: 'function_call', namespace: 'multi_agent_v1', name: 'spawn_agent', call_id: `v1-${index}`, arguments: JSON.stringify(input) } }
  })
  write(path.join(directory, 'sessions/parent/session.jsonl'), calls.map((row) => JSON.stringify(row)).join('\n'))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('unknown')
  expect(readJson(path.join(directory, 'child-assignment-review.json'))).toMatchObject({ violations: [], comparisons: [{ match: 'exact' }, { match: 'exact' }] })
})

it('correlates native code-mode collaboration events with protected hooks and detects mismatched phases', () => {
  const { root, directory, manifest, attempt, failures, audit, attribution, adherence } = setup('local-v1')
  const script = path.join(root, 'frozen/audit/child-audit-hook.cjs')
  invoke(script, audit.output, directory, { hook_event_name: 'SessionStart' })
  const rows = failures.map((failure, index) => {
    const input = { fork_context: false, model: 'synthetic-model', reasoning_effort: 'high', message: fs.readFileSync(path.join(directory, failure.childPromptPath), 'utf8') }
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) invoke(script, audit.output, directory,
      { hook_event_name, tool_name: 'spawn_agent', tool_use_id: `exec-${index}`, tool_input: input })
    return { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CollabAgentToolCall', tool: 'spawn_agent', id: `exec-${index}`,
      prompt: input.message, model: input.model, reasoning_effort: input.reasoning_effort, receiver_thread_ids: [`child-${index}`], status: 'completed' } } }
  })
  const session = path.join(directory, 'sessions/parent/session.jsonl')
  write(session, rows.map((row) => JSON.stringify(row)).join('\n'))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('unknown')
  expect(readJson(path.join(directory, 'child-assignment-review.json'))).toMatchObject({ nativeMessageCalls: 2, violations: [], comparisons: [{ match: 'exact' }, { match: 'exact' }] })
  const events = fs.readFileSync(audit.output, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  events.find((event) => event.hook_event_name === 'PostToolUse').tool_input.message = 'altered after launch'
  write(audit.output, events.map((event) => JSON.stringify(event)).join('\n'))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('violation')
  expect(readJson<{ violations: string[] }>(path.join(directory, 'child-assignment-review.json')).violations).toContain('Native hook phases differ in session or inputs: exec-0')
})

it('rejects native collaboration metadata drift and audited calls absent from native sessions', () => {
  const { root, directory, manifest, attempt, failures, audit, attribution, adherence } = setup('local-v1')
  const script = path.join(root, 'frozen/audit/child-audit-hook.cjs')
  invoke(script, audit.output, directory, { hook_event_name: 'SessionStart' })
  const input = { fork_context: false, model: 'synthetic-model', reasoning_effort: 'high', message: fs.readFileSync(path.join(directory, failures[0].childPromptPath), 'utf8') }
  for (const tool_use_id of ['native', 'unrecorded']) for (const hook_event_name of ['PreToolUse', 'PostToolUse']) invoke(script, audit.output, directory,
    { hook_event_name, tool_name: 'spawn_agent', tool_use_id, tool_input: input })
  write(path.join(directory, 'sessions/parent/session.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CollabAgentToolCall', tool: 'spawn_agent', id: 'native', prompt: 'different task', model: input.model, reasoning_effort: input.reasoning_effort } } }))
  expect(reviewChildAudit(manifest, attempt, directory, attribution, adherence).status).toBe('violation')
  expect(readJson<{ violations: string[] }>(path.join(directory, 'child-assignment-review.json')).violations).toEqual(expect.arrayContaining([
    'Audited child call absent from native session: unrecorded', 'Native collaboration event differs from audited input: native',
  ]))
})
