import type { Agent, Usage } from './types'

export function parseUsage(agent: 'codex' | 'claude', raw: string): Usage | null {
  const messages = new Map<string, Usage>()
  let codex: Usage | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object') continue
    if (agent === 'codex') {
      const usage = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload.info?.total_token_usage : null
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        codex = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cached_input_tokens ?? null, cacheWrite: usage.cache_write_input_tokens ?? null }
      }
    } else {
      const usage = row.type === 'assistant' ? row.message?.usage : null
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' && row.message.id) {
        messages.set(row.message.id, { input: usage.input_tokens, output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? null, cacheWrite: usage.cache_creation_input_tokens ?? null })
      }
    }
  }
  if (agent === 'codex') return codex
  if (!messages.size) return null
  const rows = [...messages.values()]
  const sum = (key: keyof Usage): number | null => rows.every((row) => row[key] !== null) ? rows.reduce((n, row) => n + row[key]!, 0) : null
  return { input: sum('input')!, output: sum('output')!, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') }
}
export function sessionRole(agent: 'codex' | 'claude', raw: string): 'repair' | 'approval-review' {
  if (agent === 'codex') for (const line of raw.split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object') continue
    if (row.type === 'session_meta') return row.payload?.thread_source === 'guardian_review' || row.payload?.source?.subagent?.other === 'guardian' ? 'approval-review' : 'repair'
  }
  return 'repair'
}

export function groupUsage(agent: 'codex' | 'claude', raws: string[]): Usage | null {
  const spawns = new Set<string>()
  const rejected = new Set<string>()
  for (const raw of raws) for (const line of raw.split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object') continue
    if (row.type === 'response_item' && row.payload?.type === 'function_call' && row.payload.name === 'spawn_agent') spawns.add(row.payload.call_id)
    if (row.type === 'response_item' && row.payload?.type === 'function_call_output' &&
      typeof row.payload.output === 'string' && row.payload.output.startsWith('collab spawn failed:')) rejected.add(row.payload.call_id)
    if (row.type === 'assistant') for (const block of row.message?.content ?? []) {
      if (block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) spawns.add(block.id)
    }
  }
  for (const id of rejected) spawns.delete(id)
  // Approval reviewers are platform sessions, not missing diagnosis agents.
  // Only explicit launch rejection proves a requested child never started.
  const repairRaws = raws.filter((raw) => sessionRole(agent, raw) === 'repair')
  if (!repairRaws.length || spawns.size >= repairRaws.length) return null
  const rows = agent === 'claude' ? [parseUsage(agent, raws.join('\n'))] : raws.map((raw) => parseUsage(agent, raw))
  if (rows.some((row) => row === null)) return null
  const sum = (key: keyof Usage): number | null => rows.every((row) => row![key] !== null) ? rows.reduce((total, row) => total + row![key]!, 0) : null
  return { input: sum('input')!, output: sum('output')!, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') }
}


export function totalTokens(agent: Agent, usage: Usage | null): number | null {
  if (!usage || (agent === 'claude' && (usage.cacheRead === null || usage.cacheWrite === null))) return null
  return usage.input + usage.output + (agent === 'claude' ? usage.cacheRead! + usage.cacheWrite! : 0)
}

