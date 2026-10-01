import fs from 'node:fs'
import path from 'node:path'
import { nativeSessionRecords, nativeChildMessageCalls } from '../attribution'
import { json } from '../files'
import type { ModelPin, PolicyAdherence, UsageAttribution } from '../types'

export function reviewCodexChildContext(root: string, pin: ModelPin, attribution: UsageAttribution, adherence: PolicyAdherence, backend?: 'local-v1', auditFile?: string): PolicyAdherence {
  const violations: string[] = []
  const events = auditFile && fs.existsSync(auditFile) ? nativeSessionRecords(fs.readFileSync(auditFile, 'utf8')) : []
  const launches: Array<{ sessionId: string; callId: string; forkTurns: unknown; forkContext: unknown }> = []
  for (const session of attribution.sessions.filter((entry) => entry.role === 'primary')) {
    const raw = fs.readFileSync(path.join(root, session.evidence, 'session.jsonl'), 'utf8')
    for (const item of nativeChildMessageCalls(raw).filter((call) => call.name.endsWith('spawn_agent'))) {
      let args
      if (item.arguments) {
        try { args = JSON.parse(item.arguments) } catch { violations.push(`Unreadable diagnosis launch: ${item.call_id}`); continue }
      } else {
        const pre = events.filter((event) => event.hook_event_name === 'PreToolUse' && event.tool_use_id === item.call_id && event.session_id === session.sessionId)
        if (pre.length !== 1) { violations.push(`Code-mode diagnosis launch lacks unique native hook: ${item.call_id}`); continue }
        args = pre[0].tool_input
        if (item.prompt !== args?.message || item.model !== args?.model || item.reasoning_effort !== args?.reasoning_effort) {
          violations.push(`Code-mode diagnosis metadata differs from native hook: ${item.call_id}`); continue
        }
      }
      launches.push({ sessionId: session.sessionId, callId: item.call_id, forkTurns: args.fork_turns ?? null, forkContext: args.fork_context ?? null })
      if (backend === 'local-v1' ? args.fork_context !== false : args.fork_turns !== 'none') violations.push(`Diagnosis launch ${item.call_id} inherited parent history`)
      if (args.model !== pin.model || args.reasoning_effort !== pin.effort) violations.push(`Diagnosis launch ${item.call_id} omitted or changed the frozen child model/effort`)
    }
  }
  // This proves the requested history/pin contract, not assignment coverage or
  // read-only behavior. Those still require the retained ledger and transcripts.
  json(path.join(root, 'child-context-review.json'), { launches, violations, semanticReviewRequired: true })
  return violations.length ? { ...adherence, status: 'violation', evidence: [...adherence.evidence, ...violations] } : adherence
}
