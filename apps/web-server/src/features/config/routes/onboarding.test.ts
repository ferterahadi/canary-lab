import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import {
  LEGACY_SAMPLE_SUITES,
  onboardingRoutes,
  readOnboardingSamples,
  SAMPLE_FLIGHT_DESCRIPTION,
  SAMPLE_FLIGHT_REPO_DIR,
  SAMPLE_SUITE,
  SAMPLE_SUITE_REPO_DIR,
  WORKBENCH_REPO_DIR,
  WORKBENCH_SUITE,
  isGettingStartedFlightStart,
  isGettingStartedRunFeature,
} from './onboarding'

let projectRoot: string
let featuresDir: string

function writeSuite(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: '${name}', description: 'x', envs: ['local'], featureDir: __dirname, repos: [] } }`,
  )
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-onboarding-')))
  featuresDir = path.join(projectRoot, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('readOnboardingSamples', () => {
  it('reports nothing in a workspace with no samples', () => {
    const samples = readOnboardingSamples(projectRoot, featuresDir)
    expect(samples).toMatchObject({
      sampleSuite: null,
      sampleFlightRepo: null,
      sampleFlightDescription: null,
    })
    expect(samples.workflows).toHaveLength(7)
    expect(samples.session).toEqual({ active: null, completed: {} })
    expect(samples.workflows.every((workflow) => workflow.internalAction === null)).toBe(true)
  })

  it('reports both samples a fresh scaffold leaves behind', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
    writeSuite(SAMPLE_SUITE)
    expect(readOnboardingSamples(projectRoot, featuresDir)).toMatchObject({
      sampleSuite: SAMPLE_SUITE,
      sampleFlightRepo: path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR),
      sampleFlightDescription: SAMPLE_FLIGHT_DESCRIPTION,
    })
  })

  it('serves one ordered catalog with exact prompts and prepared actions', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
    fs.mkdirSync(path.join(projectRoot, WORKBENCH_REPO_DIR))
    writeSuite(SAMPLE_SUITE)
    writeSuite(WORKBENCH_SUITE)

    const { workflows } = readOnboardingSamples(projectRoot, featuresDir)
    expect(workflows.map(({ id, group, order }) => ({ id, group, order }))).toEqual([
      { id: 'run', group: 'start', order: 1 },
      { id: 'flight', group: 'start', order: 2 },
      { id: 'coverage', group: 'more', order: 1 },
      { id: 'author', group: 'more', order: 2 },
      { id: 'portify', group: 'more', order: 3 },
      { id: 'verify', group: 'more', order: 4 },
      { id: 'export', group: 'more', order: 5 },
    ])
    expect(workflows.every((workflow) => workflow.internalAction !== null)).toBe(true)
    expect(workflows.every((workflow) => workflow.skill.startsWith('/canary-lab'))).toBe(true)
    expect(workflows.every((workflow) => workflow.externalPrompt.startsWith(workflow.skill))).toBe(true)
    expect(workflows.some((workflow) => workflow.externalPrompt.includes('$canary-lab'))).toBe(false)
    expect(workflows.some((workflow) => workflow.externalPrompt.includes('<feature>'))).toBe(false)
    // The flight prompt is the one that names a directory, so it must also carry
    // the intent — an agent that has to invent "what to test" tests something else.
    expect(workflows.find((workflow) => workflow.id === 'flight')?.externalPrompt)
      .toBe(`/canary-lab flight-app "${SAMPLE_FLIGHT_DESCRIPTION}"`)
  })

  // The samples are explicitly disposable. Nothing is remembered, so deleting
  // one retires its guide step on the very next read.
  it('drops the suite when its product repo is deleted', () => {
    writeSuite(SAMPLE_SUITE)
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleSuite).toBeNull()
  })

  it('drops the suite when the suite itself is deleted', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleSuite).toBeNull()
  })

  it('drops the flight repo and its description together', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    writeSuite(SAMPLE_SUITE)
    const samples = readOnboardingSamples(projectRoot, featuresDir)
    expect(samples.sampleFlightRepo).toBeNull()
    expect(samples.sampleFlightDescription).toBeNull()
  })

  it('ignores a suite the user renamed away from the sample', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    writeSuite('my_own_suite')
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleSuite).toBeNull()
  })

  // `upgrade` never rewrites a consumer's `features/`, so a workspace scaffolded
  // before the 1.6.0 rename still has the underscored suite. Matching only the
  // new name would report the sample as deleted for every existing user.
  it('still recognises the pre-rename suite name', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
    writeSuite(LEGACY_SAMPLE_SUITES[0])
    // Reported under the name ON DISK, because the UI prints it for the user to
    // match against the Suites column.
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleSuite).toBe(LEGACY_SAMPLE_SUITES[0])
  })

  it('prefers the current name when a workspace somehow carries both', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    writeSuite(LEGACY_SAMPLE_SUITES[0])
    writeSuite(SAMPLE_SUITE)
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleSuite).toBe(SAMPLE_SUITE)
  })

  it('does not mistake a file for the sample repo directory', () => {
    fs.writeFileSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR), 'not a directory')
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleFlightRepo).toBeNull()
  })
})

describe('external demo recognition', () => {
  it('recognizes the shipped run names without tagging ordinary features', () => {
    expect(isGettingStartedRunFeature(SAMPLE_SUITE)).toBe(true)
    expect(isGettingStartedRunFeature(LEGACY_SAMPLE_SUITES[0])).toBe(true)
    expect(isGettingStartedRunFeature('checkout')).toBe(false)
  })

  it('recognizes Full Flight by its short feature or resolved repo path', () => {
    expect(isGettingStartedFlightStart({ feature: 'flight-app' })).toBe(true)
    expect(isGettingStartedFlightStart({ feature: 'lending', repoPaths: ['/workspace/flight-app'] })).toBe(true)
    expect(isGettingStartedFlightStart({ feature: 'checkout', repoPaths: ['/workspace/shop'] })).toBe(false)
  })
})

// The route is a one-line wrapper, but an untested one is still a place the
// wiring can be wrong — a mistyped path or the deps read in the wrong order
// serves 404 or the wrong workspace's samples, and every case above would still
// pass. It also derives per request rather than caching, which is the behaviour
// the "samples are disposable" rule depends on.
describe('GET /api/onboarding', () => {
  it('serves the samples for the wired workspace, re-read on every request', async () => {
    const app = Fastify()
    await app.register(async (a) => { await onboardingRoutes(a, { projectRoot, featuresDir }) })
    try {
      const before = await app.inject({ method: 'GET', url: '/api/onboarding' })
      expect(before.statusCode).toBe(200)
      expect(before.json()).toMatchObject({ sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null })

      fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
      fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
      writeSuite(SAMPLE_SUITE)

      const after = await app.inject({ method: 'GET', url: '/api/onboarding' })
      expect(after.json()).toMatchObject({
        sampleSuite: SAMPLE_SUITE,
        sampleFlightRepo: path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR),
        sampleFlightDescription: SAMPLE_FLIGHT_DESCRIPTION,
      })
    } finally {
      await app.close()
    }
  })
})
