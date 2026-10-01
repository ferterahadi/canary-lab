import type { DiagnosisPolicy } from '../../shared/diagnosis-policy'
import type { Agent, AttributedSession, PolicyAdherence, SessionRole, Usage, UsageAttribution } from './types'
import { parseUsage, sessionRole } from './usage'

export interface SessionInput {
  sessionId: string
  raw: string | null
  evidence: string
  parentSessionId?: string
  parentToolId?: string
}

export function nativeSessionRecords(raw: string) {
  return raw.split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []
    } catch { return [] }
  })
}

// Code-mode invocations emit completed collaboration events rather than a
// top-level function_call. Use native call IDs so both surfaces deduplicate.
export function nativeChildMessageCalls(raw: string) {
  const calls = new Map<string, { call_id: string; name: string; arguments?: string; prompt?: string;
    model?: string; reasoning_effort?: string; childId?: string; rejected?: boolean }>()
  for (const row of nativeSessionRecords(raw)) {
    const item = row.payload
    if (row.type === 'response_item' && item?.type === 'function_call' &&
        /(?:^|\.)(?:spawn_agent|send_message|followup_task|send_input)$/.test(item.name ?? '')) calls.set(item.call_id, item)
    const nested = item?.item
    if (row.type === 'event_msg' && item?.type === 'item_completed' && nested?.type === 'CollabAgentToolCall' &&
        ['spawn_agent', 'send_message', 'followup_task', 'send_input'].includes(nested.tool) && !calls.has(nested.id)) {
      calls.set(nested.id, { call_id: nested.id, name: nested.tool, prompt: nested.prompt, model: nested.model,
        reasoning_effort: nested.reasoning_effort, childId: nested.receiver_thread_ids?.[0], rejected: nested.status === 'failed' })
    }
  }
  return [...calls.values()]
}

export function sumUsage(agent: Agent, raws: string[]): Usage | null {
  if (!raws.length) return null
  const usage = raws.map((raw) => parseUsage(agent, raw))
  if (usage.some((row) => row === null)) return null
  if (agent === 'claude') return parseUsage(agent, raws.join('\n'))
  const sum = (key: keyof Usage): number | null => usage.every((row) => row![key] !== null) ? usage.reduce((n, row) => n + row![key]!, 0) : null
  return { input: sum('input')!, output: sum('output')!, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') }
}

export function attributeUsage(agent: Agent, inputs: SessionInput[]): UsageAttribution {
  const issues: string[] = []
  const unique = new Map<string, SessionInput>()
  for (const input of inputs) {
    const rows = nativeSessionRecords(input.raw ?? '')
    const meta = rows.find((row) => row.type === 'session_meta')?.payload
    const native = agent === 'codex' ? meta?.id ?? meta?.session_id : rows.find((row) => row.agentId)?.agentId
    const id = native ? String(native).replace(/^agent-/, '') : input.sessionId.replace(/^agent-/, '')
    const previous = unique.get(id)
    // A session can be copied twice (primary convenience copy + archive). Sort
    // updates by native timestamp so input directory order cannot pick its total.
    const raw = previous?.raw && input.raw ? [...nativeSessionRecords(previous.raw), ...rows]
      .sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''))).map((row) => JSON.stringify(row)).join('\n') : input.raw ?? previous?.raw ?? null
    unique.set(id, { ...previous, ...input, sessionId: id, raw })
  }
  const sessions: AttributedSession[] = []
  const launches: Array<{ parent: string; call: string; child: string | null; rejected: boolean }> = []
  for (const input of unique.values()) {
    const rows = nativeSessionRecords(input.raw ?? '')
    const meta = rows.find((row) => row.type === 'session_meta')?.payload
    const childMeta = meta?.source?.subagent?.thread_spawn
    const claudeChild = rows.find((row) => row.isSidechain === true && row.agentId)
    const parent = meta?.parent_thread_id ?? childMeta?.parent_thread_id ?? input.parentSessionId ?? claudeChild?.sessionId ?? null
    let role: SessionRole = 'unknown'
    if (sessionRole(agent, input.raw ?? '') === 'approval-review') role = 'approval-review'
    else if (parent) role = 'diagnosis-child'
    else if (agent === 'codex') {
      if (meta?.thread_source === 'user' || !meta?.thread_source && typeof meta?.source === 'string' && ['cli', 'exec', 'vscode'].includes(meta.source)) role = 'primary'
    } else if (rows.some((row) => row.isSidechain === false && row.sessionId === input.sessionId)) role = 'primary'
    const timestamps = rows.map((row) => row.timestamp).filter((stamp): stamp is string => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))).sort()
    const usage = parseUsage(agent, input.raw ?? '')
    if (usage && ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some((value) => value !== null && (!Number.isFinite(value) || value < 0)) ||
      agent === 'codex' && usage.cacheRead !== null && usage.cacheRead > usage.input)) issues.push(`Inconsistent native counters: ${input.sessionId}`)
    sessions.push({ sessionId: input.sessionId, parentSessionId: parent, role, usage, evidence: input.evidence,
      startedAt: timestamps[0] ?? null, endedAt: timestamps.at(-1) ?? null })
    if (role === 'approval-review') continue
    const calls = new Map(nativeChildMessageCalls(input.raw ?? '').filter((call) => call.name.endsWith('spawn_agent'))
      .map((call) => [call.call_id, { child: call.childId ?? null, rejected: call.rejected ?? false }]))
    for (const row of rows) {
      const payload = row.payload
      if (row.type === 'response_item' && payload?.type === 'function_call' && /(?:^|\.)spawn_agent$/.test(payload.name ?? '')) calls.set(payload.call_id, { child: null, rejected: false })
      if (row.type === 'response_item' && payload?.type === 'function_call_output' && calls.has(payload.call_id)) {
        const call = calls.get(payload.call_id)!
        if (typeof payload.output === 'string' && payload.output.startsWith('collab spawn failed:')) call.rejected = true
        try { call.child = JSON.parse(payload.output).agent_id ?? null } catch { /* Native failure text is not JSON. */ }
      }
      if (row.type === 'assistant') for (const block of row.message?.content ?? []) {
        if (block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) calls.set(block.id, { child: null, rejected: false })
      }
      if (row.type === 'user') for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (block.type === 'tool_result' && block.is_error && calls.has(block.tool_use_id)) calls.get(block.tool_use_id)!.rejected = true
      }
    }
    for (const [call, launch] of calls) launches.push({ parent: input.sessionId, call, ...launch })
  }
  const missing = new Set(sessions.filter((row) => row.usage === null).map((row) => row.sessionId))
  for (const parent of new Set(launches.map((launch) => launch.parent))) {
    const requested = launches.filter((launch) => launch.parent === parent && !launch.rejected)
    const children = sessions.filter((row) => row.role === 'diagnosis-child' && row.parentSessionId === parent)
    for (const launch of requested.filter((launch) => launch.child && !unique.has(launch.child))) missing.add(launch.child!)
    // When the client returns a task path rather than an ID, native parentage
    // still proves the number captured; a shortfall remains explicitly unknown.
    if (requested.length > children.length) missing.add(`${parent}: ${requested.length - children.length} uncaptured launch(es)`)
  }
  for (const session of sessions) {
    if (session.role === 'diagnosis-child' && !unique.has(session.parentSessionId!)) issues.push(`Missing native parent for ${session.sessionId}: ${session.parentSessionId}`)
    if (session.role === 'unknown') issues.push(`Unclassified session: ${session.sessionId}`)
  }
  if (!sessions.some((row) => row.role === 'primary')) issues.push('Primary session unavailable')
  const byRole = Object.fromEntries((['primary', 'diagnosis-child', 'approval-review', 'unknown'] as const).map((role) =>
    [role, sumUsage(agent, sessions.filter((row) => row.role === role).map((row) => unique.get(row.sessionId)!.raw ?? ''))])) as Record<SessionRole, Usage | null>
  return { sessions, missingSessions: [...missing], issues, byRole,
    total: missing.size || issues.length ? null : sumUsage(agent, [...unique.values()].map((input) => input.raw ?? '')) }
}

export function assessPolicy(assigned: DiagnosisPolicy, attribution: UsageAttribution): PolicyAdherence {
  const children = attribution.sessions.filter((row) => row.role === 'diagnosis-child')
  return { assigned, status: 'unknown', childCount: children.length, reviewRequired: true,
    evidence: [assigned === 'parent-only' && children.length ? 'Diagnosis children observed; review whether an explicit, justified escalation preceded each launch.' :
      'Native session counts alone do not prove grouping, failure coverage, read-only behavior, or escalation compliance. Review transcripts.',
    ...attribution.missingSessions.map((id) => `Missing usage/session: ${id}`)] }
}
