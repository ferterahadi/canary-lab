import { DEFAULT_HEAL_ON_FAILURE_THRESHOLD } from '@shared/launcher/types'

// How the UI reads `feature.config.cjs`'s `healOnFailureThreshold`. Two
// surfaces edit the same field — Advanced setup's General tab and the flight
// Suite setup digest — and both need the same reading of an ABSENT value:
// `loadFeatures` materializes the default at load time, so an unset field is
// enabled-at-the-default, not off. Splitting that reading across two components
// is how the two lenses on one document start disagreeing.

export { DEFAULT_HEAL_ON_FAILURE_THRESHOLD }

/** A feature stops & heals by default; only an explicit `0` opts out. */
export function healEnabled(threshold: number | undefined): boolean {
  return threshold == null ? true : threshold > 0
}

/** The count the stepper shows. `0` (opted out) still displays the default, so
 *  flipping the toggle back on lands on a usable value rather than on `0`. */
export function healDisplayValue(threshold: number | undefined): number {
  return threshold != null && threshold > 0 ? threshold : DEFAULT_HEAL_ON_FAILURE_THRESHOLD
}
