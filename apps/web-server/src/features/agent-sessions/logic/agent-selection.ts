import { isAgentKind, type HealAgent } from './agent-binary'

export function resolveAvailableAgentOrder(
  preferred: HealAgent | undefined,
  pick: (preferred?: HealAgent) => HealAgent | null,
): HealAgent[] {
  // An omitted preference lets the picker retain its environment-based default.
  const agents = [preferred ? pick(preferred) : pick(), pick('claude'), pick('codex')]
    .filter(isAgentKind)
  return [...new Set(agents)]
}
