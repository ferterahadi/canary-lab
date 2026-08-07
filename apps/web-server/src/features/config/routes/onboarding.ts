import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../../shared/feature-loader'

// What the scaffold's own demonstration still looks like in this workspace.
//
// `init` lands two sample repos and one worked suite. The first-run guide in the
// web UI points a new user at them, and it can only do that if it knows they are
// still there — the samples are explicitly disposable, and a guide that points at
// a deleted `flight-app/` is worse than no guide. Everything here is DERIVED from
// what is on disk right now; nothing is remembered, so deleting a sample retires
// its step immediately, and restoring it brings the step back.

/** Names the scaffold uses. A renamed or deleted sample simply stops matching —
 *  the guide narrows rather than pointing somewhere that no longer exists. */
export const SAMPLE_SUITE = 'storefront_journey'
export const SAMPLE_SUITE_REPO_DIR = 'demo-app'
export const SAMPLE_FLIGHT_REPO_DIR = 'flight-app'

/** What the bare sample repo is for, in the words a Flight wants: the thing to
 *  test. Lives here beside the sample's own definition so the web UI does not
 *  have to carry knowledge of what `flight-app` contains. */
export const SAMPLE_FLIGHT_DESCRIPTION =
  'the library lending flow: borrow a copy, return it, and see it available again'

export interface OnboardingSamples {
  /** The shipped worked suite, when both it and its product repo are present.
   *  Null once either is gone. */
  sampleSuite: string | null
  /** Absolute path to the bare repo a Flight can onboard, when still present. */
  sampleFlightRepo: string | null
  /** Prefill for that Flight's "what should it test?" field. Null whenever
   *  `sampleFlightRepo` is. */
  sampleFlightDescription: string | null
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readOnboardingSamples(projectRoot: string, featuresDir: string): OnboardingSamples {
  const suitePresent =
    isDir(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR)) &&
    loadFeatures(featuresDir).some((f) => f.name === SAMPLE_SUITE)
  const flightRepo = path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR)
  const flightRepoPresent = isDir(flightRepo)
  return {
    sampleSuite: suitePresent ? SAMPLE_SUITE : null,
    sampleFlightRepo: flightRepoPresent ? flightRepo : null,
    sampleFlightDescription: flightRepoPresent ? SAMPLE_FLIGHT_DESCRIPTION : null,
  }
}

export async function onboardingRoutes(
  app: FastifyInstance,
  deps: { projectRoot: string; featuresDir: string },
): Promise<void> {
  app.get('/api/onboarding', async () => readOnboardingSamples(deps.projectRoot, deps.featuresDir))
}
