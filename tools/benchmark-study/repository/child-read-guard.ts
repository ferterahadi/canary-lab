import fs from 'node:fs'
import path from 'node:path'
import { json, quote, readJson, sha, write } from '../files'
import type { Attempt, PolicyAdherence, StudyManifest } from '../types'

const FROZEN = 'frozen/audit/child-read-guard.cjs'

export function freezeChildReadGuard(root: string): void {
  write(path.join(root, FROZEN), fs.readFileSync(path.join(__dirname, 'child-read-guard.cjs'), 'utf8'))
}

/** Native hook registrations that constrain every diagnosis child's tool call.
 * Both CLIs mark a child's calls with `agent_id`; the parent's carry none. */
export function childReadGuard(manifest: StudyManifest, attempt: Attempt, root: string) {
  const script = path.join(manifest.root, FROZEN)
  // A campaign frozen before the guard existed must not run children unguarded.
  if (!fs.existsSync(script)) throw new Error('Repository campaign lacks the frozen child read guard')
  const output = path.join(manifest.root, 'audit', attempt.id, 'child-guard.jsonl')
  const handler = { type: 'command', command: [process.execPath, script, output, root].map(quote).join(' '), timeout: 5 }
  const hooks = { SubagentStart: [{ hooks: [handler] }],
    PreToolUse: [{ matcher: attempt.agent === 'claude' ? '*' : '.*', hooks: [handler] }] }
  return { script, output, hooks, scriptSha256: sha(fs.readFileSync(script)) }
}

/** Claude reads hooks from the study's own `--settings` file, which the agent cannot write. */
export function installClaudeChildReadGuard(settingsFile: string, hooks: object): void {
  json(settingsFile, { ...readJson<Record<string, unknown>>(settingsFile), hooks })
}

export function reviewChildReadGuard(manifest: StudyManifest, attempt: Attempt, root: string, adherence: PolicyAdherence): PolicyAdherence {
  const output = path.join(manifest.root, 'audit', attempt.id, 'child-guard.jsonl')
  const records = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { agent_id: string; hook_event_name: string; decision: string; tool_name?: string; reason?: string }) : []
  const guarded = new Set(records.filter((record) => record.hook_event_name === 'SubagentStart').map((record) => record.agent_id))
  const denied = records.filter((record) => record.decision === 'deny')
    .map(({ agent_id, tool_name, reason }) => ({ agentId: agent_id, tool: tool_name, reason }))
  // Native transcripts count the children; the guard must have started on each.
  const violations = guarded.size < adherence.childCount
    ? [`Child read guard observed ${guarded.size} of ${adherence.childCount} diagnosis children`] : []
  json(path.join(root, 'child-read-guard-review.json'), { children: adherence.childCount, guarded: guarded.size,
    toolCalls: records.filter((record) => record.hook_event_name === 'PreToolUse').length, denied, violations })
  if (violations.length) return { ...adherence, status: 'violation', evidence: [...adherence.evidence, ...violations] }
  if (!adherence.childCount) return adherence
  return { ...adherence, evidence: [...adherence.evidence, `Protected child read guard covered ${guarded.size} children and denied ${denied.length} out-of-scope call(s).`] }
}
