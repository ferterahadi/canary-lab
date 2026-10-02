import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { json, readJson, write } from '../files'
import type { Attempt, PolicyAdherence, StudyManifest } from '../types'
import { childReadGuard, freezeChildReadGuard, installClaudeChildReadGuard, reviewChildReadGuard } from './child-read-guard'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function setup(agent: 'claude' | 'codex' = 'codex') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'child-read-guard-')))
  roots.push(root)
  const attempt = { id: 'synthetic-attempt', agent } as Attempt
  const manifest = { root } as StudyManifest
  const directory = path.join(root, 'attempts', attempt.id)
  write(path.join(directory, 'app/src/value.ts'), 'export const value = 1\n')
  json(path.join(directory, 'failure-context/failure-2/diagnostic.json'), { messages: ['OTHER'] })
  write(path.join(directory, 'heal-index.md'), '# index\n')
  write(path.join(directory, 'check.cjs'), '\n')
  freezeChildReadGuard(root)
  return { root, directory, manifest, attempt, guard: childReadGuard(manifest, attempt, directory) }
}

function call(guard: ReturnType<typeof setup>['guard'], directory: string, event: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [guard.script, guard.output, directory],
    { input: JSON.stringify({ cwd: directory, session_id: 'parent', hook_event_name: 'PreToolUse', ...event }), encoding: 'utf8' })
  const reason = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason as string : null
  return { status: result.status, denied: !!reason, reason }
}

const child = { agent_id: 'child-1', agent_type: 'default' }
const shell = (command: string) => ({ ...child, tool_name: 'Bash', tool_input: { command } })

it('lets the parent work anywhere and records nothing for it', () => {
  const { directory, guard } = setup()
  expect(call(guard, directory, { tool_name: 'Bash', tool_input: { command: 'cat failure-context/failure-2/diagnostic.json' } })).toMatchObject({ status: 0, denied: false })
  expect(call(guard, directory, { tool_name: 'Read', cwd: os.tmpdir(), tool_input: { file_path: path.join(directory, 'heal-index.md') } }).denied).toBe(false)
  expect(fs.existsSync(guard.output)).toBe(false)
})

it('allows a child to read and search the application tree', () => {
  const { directory, guard } = setup()
  for (const event of [
    { ...child, tool_name: 'Read', tool_input: { file_path: path.join(directory, 'app/src/value.ts') } },
    { ...child, tool_name: 'Grep', tool_input: { pattern: 'value', path: 'app/src' } },
    { ...child, tool_name: 'Glob', tool_input: { pattern: '**/*.ts', path: path.join(directory, 'app') } },
    { ...child, tool_name: 'SubagentHandback', tool_input: {} },
    shell('cat app/src/value.ts'),
    shell("rg -n 'a/b$' app/src"),
    shell("rg -g '*.ts' -n value app/src"),
    shell("sed -n '/value/,/end/p' app/src/value.ts"),
    shell("find app/src -name '*.ts' | head"),
    shell('cd app/src && grep -rn value .'),
    { ...child, tool_name: 'Bash', tool_input: { command: 'grep -rn value .', workdir: 'app' } },
  ]) expect(call(guard, directory, event), JSON.stringify(event)).toMatchObject({ status: 0, denied: false })
})

it('denies a child every route to another failure packet or parent context', () => {
  const { directory, guard } = setup()
  for (const event of [
    { ...child, tool_name: 'Read', tool_input: { file_path: path.join(directory, 'failure-context/failure-2/diagnostic.json') } },
    { ...child, tool_name: 'Read', tool_input: { file_path: 'heal-index.md' } },
    { ...child, tool_name: 'Grep', tool_input: { pattern: 'OTHER' } },
    { ...child, tool_name: 'Glob', tool_input: { pattern: path.join(directory, 'failure-context/**') } },
    shell('cat failure-context/failure-2/diagnostic.json'),
    shell('cat heal-index.md'),
    shell('grep -rn OTHER .'),
    shell('rg OTHER'),
    shell('ls -R'),
    shell('cat app/../heal-index.md'),
    shell('cd .. && cat heal-index.md'),
    shell('cat "$(ls failure-context)"'),
    shell('cat ~/secret'),
    shell('cat app/src/value.ts > /tmp/copy && cat failure-context/*/diagnostic.json'),
    shell('node check.cjs'),
  ]) expect(call(guard, directory, event), JSON.stringify(event)).toMatchObject({ status: 0, denied: true })
})

it('keeps a child read-only and unable to delegate', () => {
  const { directory, guard } = setup()
  for (const tool_name of ['Edit', 'Write', 'apply_patch', 'Agent', 'spawn_agent', 'mcp__canary__exec']) {
    expect(call(guard, directory, { ...child, tool_name, tool_input: {} }).reason).toContain('read-only')
  }
})

it('blocks a child call whose event cannot be checked', () => {
  const { directory, guard } = setup()
  expect(call(guard, directory, { ...child, tool_name: 'Read', cwd: os.tmpdir() }).status).toBe(2)
  expect(spawnSync(process.execPath, [guard.script, guard.output, directory], { input: 'not json', encoding: 'utf8' }).status).toBe(2)
})

it('refuses to run children from a campaign frozen without the guard', () => {
  const { root, directory, manifest, attempt } = setup()
  fs.rmSync(path.join(root, 'frozen/audit/child-read-guard.cjs'))
  expect(() => childReadGuard(manifest, attempt, directory)).toThrow('lacks the frozen child read guard')
})

it('registers the guard on every Claude tool call through the protected settings file', () => {
  const { directory, guard } = setup('claude')
  const settings = path.join(directory, 'agent-isolation.json')
  json(settings, { permissions: { deny: ['Read(/private)'] } })
  installClaudeChildReadGuard(settings, guard.hooks)
  expect(readJson(settings)).toMatchObject({ permissions: { deny: ['Read(/private)'] },
    hooks: { SubagentStart: [{ hooks: [{ type: 'command' }] }], PreToolUse: [{ matcher: '*' }] } })
})

it('fails an attempt whose diagnosis children ran outside the guard and reports denials otherwise', () => {
  const { directory, manifest, attempt, guard } = setup()
  const adherence = { assigned: 'per-failure', status: 'unknown', childCount: 2, reviewRequired: true, evidence: [] } as PolicyAdherence
  call(guard, directory, { ...child, hook_event_name: 'SubagentStart' })
  call(guard, directory, shell('cat heal-index.md'))
  expect(reviewChildReadGuard(manifest, attempt, directory, adherence)).toMatchObject({ status: 'violation',
    evidence: ['Child read guard observed 1 of 2 diagnosis children'] })
  call(guard, directory, { ...child, agent_id: 'child-2', hook_event_name: 'SubagentStart' })
  expect(reviewChildReadGuard(manifest, attempt, directory, adherence)).toMatchObject({ status: 'unknown',
    evidence: ['Protected child read guard covered 2 children and denied 1 out-of-scope call(s).'] })
  expect(readJson(path.join(directory, 'child-read-guard-review.json'))).toMatchObject({ children: 2, guarded: 2, toolCalls: 1,
    denied: [{ agentId: 'child-1', tool: 'Bash' }], violations: [] })
  const parentOnly = { ...adherence, assigned: 'parent-only', childCount: 0 } as PolicyAdherence
  expect(reviewChildReadGuard(manifest, attempt, directory, parentOnly)).toBe(parentOnly)
})
