// The prose a heal cycle produces: the give-up suffix that says why an agent
// went quiet, the transcript block for a user interjection, and the placeholder
// prompt tests fall back to.
//
// Split out of orchestrator.ts. Wording here is user-facing run evidence — it
// explains a verdict — so each function is pinned by a test rather than left to
// be reachable only by driving a live heal loop.

import type { HealEnd } from '../../../../../../../shared/run-state'
import type { BuildHealCyclePromptArgs } from './auto-heal'

// How much of the heal agent's terminal output to keep for the no-signal
// give-up classifier. ~16 KB is plenty to catch a usage-limit / auth banner at
// the tail without holding the whole conversation in memory.
export const HEAL_AGENT_TAIL_BYTES = 16 * 1024

// Human-readable suffix appended to the no-signal give-up message when the
// classifier recognized why the agent went quiet. `unknown`/undefined add
// nothing (we only editorialize when we actually recognized the cause).
export function healAgentCauseSuffix(cause: HealEnd['agentCause']): string {
  switch (cause) {
    case 'usage-limit':
      return ' Its last output suggests the agent hit a usage limit.'
    case 'auth':
      return ' Its last output suggests the agent is not signed in.'
    case 'rate-limit':
      return ' Its last output suggests the agent was rate-limited or the model was overloaded.'
    case 'crash':
      return ' Its last output suggests the agent crashed or failed to start.'
    default:
      return ''
  }
}

export function formatUserInterjectBlock(text: string, startedAt: string, now: Date = new Date()): string {
  const tag = formatElapsedTag(startedAt, now)
  const body = text.split(/\r?\n/).map((line) => `  │ ${line}`).join('\n')
  return `\n${tag} user interject\n${body}\n\n`
}

function formatElapsedTag(startedAt: string, now: Date): string {
  const started = new Date(startedAt).getTime()
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0
  const s = Math.floor(elapsedMs / 1000)
  const mm = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return `[${mm}:${ss}]`
}

export function defaultHealPrompt(args: BuildHealCyclePromptArgs): string {
  const guidance = args.userGuidance ? ` guidance="${args.userGuidance}"` : ''
  const prior = args.priorAgentSessionContext ? ' prior-session=true' : ''
  return `[heal-agent placeholder cycle=${args.cycle} mcp-out=${args.outputDir}${guidance}${prior}]`
}
