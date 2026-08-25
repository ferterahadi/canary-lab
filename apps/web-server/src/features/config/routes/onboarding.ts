import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../../shared/feature-loader'
import type { GettingStartedSessionState, GettingStartedSessionStore } from '../logic/getting-started-session'

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
export const SAMPLE_SUITE = 'storefront-journey'

/** The name this suite carried between its introduction and the 2.0.0 rename to
 *  the kebab-case a flight's plan agent produces. Both landed inside the same
 *  development cycle, so NO published release shipped the underscored name — this
 *  covers pre-release workspaces only, and claiming it protects upgrading users
 *  would be false. What a real pre-2.0.0 workspace has is PRE_2_0_SAMPLE_SUITES. */
export const LEGACY_SAMPLE_SUITES = ['storefront_journey'] as const

/** The sample suites a workspace scaffolded by 1.5.x and earlier actually carries.
 *
 *  Deliberately NOT aliases of the storefront demo: they are different apps with
 *  different specs, so treating one as the demo would point every Getting Started
 *  card at a suite that cannot do what the card promises. They are here as the one
 *  reliable signal that this workspace PREDATES the 2.0.0 samples, which is what
 *  separates "you deleted it" from "you never had it" — `upgrade` deliberately
 *  never writes `features/`, so upgrading alone can never produce the demos. */
export const PRE_2_0_SAMPLE_SUITES = [
  'example_todo_api',
  'broken_todo_api',
  'flaky_orders_api',
  'tricky_checkout_api',
] as const
export const SAMPLE_SUITE_REPO_DIR = 'demo-app'
export const SAMPLE_FLIGHT_REPO_DIR = 'flight-app'
export const WORKBENCH_SUITE = 'workflow-workbench'
export const WORKBENCH_REPO_DIR = 'workflow-app'

export type GettingStartedRunWorkflow = 'run' | 'heal'

/** A normal run started through MCP has no card id in its tool arguments, so
 *  the shipped fixture names are the stable attribution boundary. Storefront
 *  owns the starter repair card; the workbench owns the later run/heal card. */
export function gettingStartedRunWorkflow(feature: string): GettingStartedRunWorkflow | null {
  if (feature === SAMPLE_SUITE || LEGACY_SAMPLE_SUITES.some((name) => name === feature)) return 'run'
  if (feature === WORKBENCH_SUITE) return 'heal'
  return null
}

export function isGettingStartedRunFeature(feature: string): boolean {
  return gettingStartedRunWorkflow(feature) !== null
}

export function isGettingStartedFlightStart(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  if (payload.feature === SAMPLE_FLIGHT_REPO_DIR) return true
  const repos = Array.isArray(payload.repoPaths) ? payload.repoPaths : []
  return repos.some((repo) => typeof repo === 'string' && path.basename(repo) === SAMPLE_FLIGHT_REPO_DIR)
}

/** What the bare sample repo is for, in the words a Flight wants: the thing to
 *  test. Lives here beside the sample's own definition so the web UI does not
 *  have to carry knowledge of what `flight-app` contains. */
export const SAMPLE_FLIGHT_DESCRIPTION =
  'the library lending flow: borrow a copy, return it, and see it available again'

export type OnboardingWorkflowId =
  | 'run'
  | 'flight'
  | 'coverage'
  | 'export'
  | 'author'
  | 'heal'
  | 'portify'

export type OnboardingWorkflowAction =
  | { kind: 'run'; feature: string }
  | { kind: 'flight'; repoPath: string; description: string }
  | { kind: 'coverage'; feature: string }
  | { kind: 'export'; feature: string }
  | { kind: 'author'; feature: string }
  | { kind: 'heal'; feature: string }
  | { kind: 'portify'; feature: string }

export interface OnboardingWorkflow {
  id: OnboardingWorkflowId
  group: 'start' | 'more'
  order: number
  title: string
  outcome: string
  steps: string[]
  skill: string
  externalPrompt: string
  internalAction: OnboardingWorkflowAction | null
  unavailableReason: string | null
}

export interface OnboardingSamples {
  /** The shipped worked suite, when both it and its product repo are present.
   *  Null once either is gone. */
  sampleSuite: string | null
  /** Absolute path to the bare repo a Flight can onboard, when still present. */
  sampleFlightRepo: string | null
  /** Prefill for that Flight's "what should it test?" field. Null whenever
   *  `sampleFlightRepo` is. */
  sampleFlightDescription: string | null
  /** The executable Getting Started catalog. Server-owned because prompts need
   *  this workspace's absolute paths and actions must reflect which disposable
   *  fixtures still exist on disk. */
  workflows: OnboardingWorkflow[]
  /** Persisted shared state for the four core demos. */
  session: GettingStartedSessionState
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readOnboardingSamples(
  projectRoot: string,
  featuresDir: string,
  session: GettingStartedSessionState = { active: null, completed: {} },
): OnboardingSamples {
  // Report the name that is actually on disk, not the constant: the UI prints it
  // so a first-time user can match it against the Suites column, and naming a row
  // that isn't there would be worse than naming none.
  const names = new Set(loadFeatures(featuresDir).map((f) => f.name))
  const presentSuite = [SAMPLE_SUITE, ...LEGACY_SAMPLE_SUITES].find((n) => names.has(n)) ?? null
  const suitePresent = isDir(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR)) && presentSuite !== null
  const flightRepo = path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR)
  const flightRepoPresent = isDir(flightRepo)
  const workbenchPresent = isDir(path.join(projectRoot, WORKBENCH_REPO_DIR)) && names.has(WORKBENCH_SUITE)
  const sampleFeature = presentSuite ?? SAMPLE_SUITE
  const workbenchFeature = WORKBENCH_SUITE
  // None of the three sample repos here, but a suite only 1.5.x and earlier
  // scaffolded: this workspace was created before the samples existed rather
  // than stripped of them. Both conditions are needed — the repo dirs alone
  // cannot tell a legacy workspace from one whose samples were all deleted, and
  // an old suite name alone survives in a 2.0.0 workspace the user added to.
  const predatesSamples =
    !suitePresent
    && !flightRepoPresent
    && !workbenchPresent
    && PRE_2_0_SAMPLE_SUITES.some((n) => names.has(n))
  // Telling someone their demo was "removed" names a deletion they never made and
  // offers no way forward. Upgrading cannot add these samples, so the legacy
  // wording has to carry the only thing that can.
  const missingSample = (noun: string): { internalAction: null; unavailableReason: string } => ({
    internalAction: null,
    unavailableReason: predatesSamples
      ? `${noun} ships with workspaces scaffolded by 2.0.0 or newer. Upgrading never adds it — run \`npx canary-lab init <folder>\` for a workspace that has it.`
      : `${noun} was removed from this workspace.`,
  })
  const sampleAction = <T extends OnboardingWorkflowAction>(action: T): {
    internalAction: T
    unavailableReason: null
  } => ({ internalAction: action, unavailableReason: null })
  const suiteAvailability = suitePresent
    ? sampleAction({ kind: 'run', feature: sampleFeature })
    : missingSample('The storefront demo')
  const workbenchAvailability = <T extends Exclude<OnboardingWorkflowAction, { kind: 'run' | 'flight' }>>(action: T) =>
    workbenchPresent
      ? sampleAction(action)
      : missingSample('The workflow workbench')
  const workflows: OnboardingWorkflow[] = [
    {
      id: 'run',
      group: 'start',
      order: 1,
      title: 'Repair a Broken Suite',
      outcome: 'Run the prepared storefront suite and repair the app until it passes.',
      steps: ['Start the app', 'Run the suite', 'Repair the app'],
      skill: '/canary-lab-run',
      externalPrompt: `/canary-lab-run ${sampleFeature}`,
      ...suiteAvailability,
    },
    {
      id: 'flight',
      group: 'start',
      order: 2,
      title: 'Take a Repo Through Full Flight',
      outcome: 'Take the prepared lending app from an empty repo to a finished evaluation.',
      steps: ['Understand the repo', 'Create and run tests', 'Export the evaluation'],
      skill: '/canary-lab',
      // The only prompt here that names a DIRECTORY rather than a suite. Every
      // other workflow passes a suite name the server resolves on its own, so a
      // bare token is enough; a flight takes repo paths and an intent, and an
      // agent handed neither has to invent the intent — which changes what gets
      // tested. Carry the same description the GUI button passes, and let the
      // skill resolve `flight-app` against the workspace the server serves.
      externalPrompt: `/canary-lab ${SAMPLE_FLIGHT_REPO_DIR} "${SAMPLE_FLIGHT_DESCRIPTION}"`,
      ...(flightRepoPresent
        ? sampleAction({ kind: 'flight', repoPath: flightRepo, description: SAMPLE_FLIGHT_DESCRIPTION })
        : missingSample('The bare Flight repository')),
    },
    {
      id: 'coverage',
      group: 'more',
      order: 1,
      title: 'Measure Coverage',
      outcome: 'See what is tested and what is missing.',
      steps: ['Read requirements', 'Match tests', 'Show gaps'],
      skill: '/canary-lab-coverage',
      externalPrompt: `/canary-lab-coverage ${workbenchFeature}`,
      ...workbenchAvailability({ kind: 'coverage', feature: workbenchFeature }),
    },
    {
      id: 'author',
      group: 'more',
      order: 2,
      title: 'Author Tests',
      outcome: 'Write a test for the missing behavior.',
      steps: ['Choose a gap', 'Write the test', 'Run it'],
      skill: '/canary-lab-author',
      externalPrompt: `/canary-lab-author ${workbenchFeature}`,
      ...workbenchAvailability({ kind: 'author', feature: workbenchFeature }),
    },
    {
      id: 'portify',
      group: 'more',
      order: 3,
      title: 'Enable Parallel Runs',
      outcome: 'Make the app safe to run more than once at the same time.',
      steps: ['Replace fixed ports', 'Start two copies', 'Confirm both work'],
      skill: '/canary-lab-portify',
      externalPrompt: `/canary-lab-portify ${workbenchFeature}`,
      ...workbenchAvailability({ kind: 'portify', feature: workbenchFeature }),
    },
    {
      id: 'heal',
      group: 'more',
      order: 4,
      title: 'Run and Heal a Feature',
      outcome: 'Complete a normal test run that can be exported as an evaluation.',
      steps: ['Run the suite', 'Heal failures', 'Finish passing'],
      skill: '/canary-lab-run',
      externalPrompt: `/canary-lab-run ${workbenchFeature}`,
      ...workbenchAvailability({ kind: 'heal', feature: workbenchFeature }),
    },
    {
      id: 'export',
      group: 'more',
      order: 5,
      title: 'Export an Evaluation',
      outcome: 'Turn a completed run into a reviewable evaluation.',
      steps: ['Collect results', 'Add repair evidence', 'Create evaluation'],
      skill: '/canary-lab-export',
      externalPrompt: `/canary-lab-export ${workbenchFeature}`,
      ...workbenchAvailability({ kind: 'export', feature: workbenchFeature }),
    },
  ]
  return {
    sampleSuite: suitePresent ? presentSuite : null,
    sampleFlightRepo: flightRepoPresent ? flightRepo : null,
    sampleFlightDescription: flightRepoPresent ? SAMPLE_FLIGHT_DESCRIPTION : null,
    workflows,
    session,
  }
}

export async function onboardingRoutes(
  app: FastifyInstance,
  deps: { projectRoot: string; featuresDir: string; sessionStore?: GettingStartedSessionStore },
): Promise<void> {
  app.get('/api/onboarding', async () => readOnboardingSamples(
    deps.projectRoot,
    deps.featuresDir,
    deps.sessionStore?.read(),
  ))
}
