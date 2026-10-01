import type { ParsedConfigDoc } from '@/shared/api/client'

/** Unique port-slot names declared across every start command in the feature
 *  config (duck-typed walk of the parsed doc — same shape PortsTab edits). */
export function extractPortSlots(doc: ParsedConfigDoc): string[] {
  const out: string[] = []
  const root = doc.parsed.value
  if (!root || typeof root !== 'object' || Array.isArray(root)) return out
  const repos = (root as Record<string, unknown>).repos
  if (!Array.isArray(repos)) return out
  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') continue
    const commands = (repo as Record<string, unknown>).startCommands
    if (!Array.isArray(commands)) continue
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object') continue
      const ports = (cmd as Record<string, unknown>).ports
      if (!Array.isArray(ports)) continue
      for (const p of ports) {
        if (!p || typeof p !== 'object') continue
        const name = (p as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim() && !out.includes(name)) out.push(name)
      }
    }
  }
  return out
}
