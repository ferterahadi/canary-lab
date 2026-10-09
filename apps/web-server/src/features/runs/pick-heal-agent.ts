import type { HealAgentChoice } from '../../../../../shared/project-config'
// Which local heal agent a run should use: the persisted per-run choice wins,
// then the project config, then availability. Shared by the runs route deps and
// the local-heal restart, so it lives beside both rather than inside either.
import { pickAvailableHealAgent } from './logic/runtime/heal-agent-spawn'
import { isAgentKind, type HealAgent } from '../agent-sessions/logic/agent-binary'
import { resolveAvailableAgentOrder } from '../agent-sessions/logic/agent-selection'

import type { LocalHealAgent } from '../../../../../shared/run-manifest'

export function pickConfiguredHealAgent(
  configured: HealAgentChoice,
  persisted?: LocalHealAgent,
): HealAgent | null {
  if (persisted) return pickAvailableHealAgent(persisted)
  if (configured === 'auto') return pickAvailableHealAgent()
  if (isAgentKind(configured)) return pickAvailableHealAgent(configured)
  return null
}

// The agent order for a read-only pass (PRD summary, annotate, evaluation
// rewrite): an adapter that names an agent is tried first; any other adapter
// ('auto', 'deterministic', unset) keeps the picker's environment default.
export function resolveAgentsFor(adapter: string | undefined): HealAgent[] {
  return resolveAvailableAgentOrder(isAgentKind(adapter) ? adapter : undefined, pickAvailableHealAgent)
}
