// Can this feature boot alongside a second copy of itself?
//
// The answer is a property of the CONFIG, not of Portify: a service that
// natively reads its port from the environment declares its slot straight in
// feature.config.cjs and is concurrency-ready with no overlay at all. Portify
// exists for the services that don't — it rewrites them and saves an overlay —
// so "has an overlay" is one route to injectable, never the definition of it.
//
// One home for the predicate because three surfaces answer with it and must
// agree: the Ports tab's state band, the flight's Parallel readiness stage, and
// the MCP `list_portify_status` tool.

export type PortInjectability =
  /** Every start command carries a port slot — nothing left to make injectable. */
  | 'declared'
  /** Some commands have slots; the rest would still clash on a second run. */
  | 'partial'
  /** No slots anywhere. Portify (or hand-declaring them) is the way in. */
  | 'none'

/** The only shape this predicate reads. Deliberately structural rather than
 *  `RepoPrerequisite`: the web UI's config editor carries repos whose paths are
 *  unresolved `${…}` expressions, and none of that matters to the question of
 *  whether a start command declares a port. */
export interface PortSlotBearingRepo {
  startCommands?: readonly (string | { ports?: readonly unknown[] })[]
}

/** Start commands across every repo, in declaration order. A bare string
 *  command declares no ports, so it can never be injectable. */
export function startCommandPortSlotCounts(repos: readonly PortSlotBearingRepo[] | undefined): {
  total: number
  slotted: number
} {
  const commands = (repos ?? []).flatMap((r) => r.startCommands ?? [])
  const slotted = commands.filter((c) => typeof c !== 'string' && (c.ports?.length ?? 0) > 0)
  return { total: commands.length, slotted: slotted.length }
}

/** A feature that starts nothing reports `none`: there is no service to make
 *  injectable, and claiming otherwise would put a green tick on a stage that
 *  never had anything to do. */
export function portInjectability(repos: readonly PortSlotBearingRepo[] | undefined): PortInjectability {
  const { total, slotted } = startCommandPortSlotCounts(repos)
  if (total === 0 || slotted === 0) return 'none'
  return slotted === total ? 'declared' : 'partial'
}
