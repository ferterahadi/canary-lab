// Cross-feature refetch bus. Replaces the seven ad-hoc `*RefreshKey` integers
// the App used to own and drill down to whichever leaf renders a given surface
// (coverage badge, ports tab, repos git-status, verification config, spec list,
// run journal, flight detail). A WS event that mutated one of those surfaces
// used to `setXxxRefreshKey(k => k + 1)` in the App and pass the new value as a
// prop; the leaf held it as a `useEffect` dep and refetched on change.
//
// The bus keeps that exact "bump a version → the fetcher's effect re-runs"
// semantics but moves the version store into context, so a leaf reads its own
// version via `useInvalidationKey(topic)` instead of receiving a drilled prop.
// Some surfaces are scoped (the journal is per-run, tests/verification per the
// selected feature) — a `scope` string qualifies the slot so a bump for run A
// doesn't refetch run B.
//
// Pure map math lives here (jsdom-free, unit-tested); the React wiring is in
// `invalidation.tsx`.

export type InvalidationTopic =
  | 'coverage'
  | 'ports'
  | 'repos'
  | 'verification'
  | 'tests'
  | 'flights'
  | 'journal'
  | 'project-config'

/** The version map: slot key → monotonically-increasing version. A slot is a
 *  topic, optionally qualified by a scope (`journal:<runId>`). */
export type InvalidationState = Readonly<Record<string, number>>

export const EMPTY_INVALIDATION: InvalidationState = {}

/** The map key for a topic (+ optional scope). Exposed so tests and the hook
 *  agree on the slot naming. */
export function invalidationSlot(topic: InvalidationTopic, scope?: string): string {
  return scope ? `${topic}:${scope}` : topic
}

/** Return a new state with the topic's (scoped) version incremented. Immutable
 *  — the previous state is never mutated, so React sees a fresh reference. */
export function bumpInvalidation(
  state: InvalidationState,
  topic: InvalidationTopic,
  scope?: string,
): InvalidationState {
  const slot = invalidationSlot(topic, scope)
  return { ...state, [slot]: (state[slot] ?? 0) + 1 }
}

/** Read the current version for a topic (+ optional scope). Unbumped slots read
 *  0, matching the `useState(0)` initial the refresh keys used to have. */
export function readInvalidation(
  state: InvalidationState,
  topic: InvalidationTopic,
  scope?: string,
): number {
  return state[invalidationSlot(topic, scope)] ?? 0
}
