import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
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

  it('does not mistake a file for the sample repo directory', () => {
    fs.writeFileSync(path.join(projectRoot, SAMPLE_FLIGHT_REPO_DIR), 'not a directory')
    expect(readOnboardingSamples(projectRoot, featuresDir).sampleFlightRepo).toBeNull()
  })
})
