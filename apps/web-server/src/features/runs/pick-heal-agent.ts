// Which local heal agent a run should use: the persisted per-run choice wins,
// then the project config, then availability. Shared by the runs route deps and
// the local-heal restart, so it lives beside both rather than inside either.
import { pickAvailableHealAgent, type HealAgent } from './logic/runtime/auto-heal'
import type { HealAgentChoice } from './logic/runtime/launcher/project-config'
import type { LocalHealAgent } from './logic/runtime/manifest'

export function pickConfiguredHealAgent(
  configured: HealAgentChoice,
  persisted?: LocalHealAgent,
): HealAgent | null {
  if (persisted) return pickAvailableHealAgent(persisted)
  if (configured === 'auto') return pickAvailableHealAgent()
  if (configured === 'claude' || configured === 'codex') return pickAvailableHealAgent(configured)
  return null
}
