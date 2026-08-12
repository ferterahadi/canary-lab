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
    expect(readOnboardingSamples(projectRoot, featuresDir)).toEqual({
      sampleSuite: null,
      sampleFlightRepo: null,
      sampleFlightDescription: null,
    })
  })

  it('reports both samples a fresh scaffold leaves behind', () => {
    fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
    fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
    writeSuite(SAMPLE_SUITE)
    expect(readOnboardingSamples(projectRoot, featuresDir)).toEqual({
      sampleSuite: SAMPLE_SUITE,
      sampleFlightRepo: path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR),
      sampleFlightDescription: SAMPLE_FLIGHT_DESCRIPTION,
    })
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
      expect(before.json()).toEqual({ sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null })

      fs.mkdirSync(path.join(projectRoot, SAMPLE_SUITE_REPO_DIR))
      fs.mkdirSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR))
      writeSuite(SAMPLE_SUITE)

      const after = await app.inject({ method: 'GET', url: '/api/onboarding' })
      expect(after.json()).toEqual({
        sampleSuite: SAMPLE_SUITE,
        sampleFlightRepo: path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR),
        sampleFlightDescription: SAMPLE_FLIGHT_DESCRIPTION,
      })
    } finally {
      await app.close()
    }
  })
})
