import { describe, it, expect, beforeEach } from 'vitest'

import fs from 'fs'

import path from 'path'

import { buildSpecsPrompt, specsCoverageStage, defaultValidateSpecs, tscErrorsForFeature } from './specs-coverage'

import { portifyStage } from './portify'

import { runStage, healStage } from './run'

import { evaluationExportStage } from './evaluation-export'
import { createEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageOutcome } from '../flight-stages'

import type { FlightManifest } from '../../../../../../../shared/flights/types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { flightStageCtx, stageDirs, stageDeps, stageManifest } from './__fixtures__/stage-context'
import { fakeFlightInject, type FlightInjectCall } from './__fixtures__/flight-inject'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-flight-stages-')

let tmpDir: string

let featuresDir: string

let logsDir: string

let repoDir: string

beforeEach(() => {
  ({ tmpDir, featuresDir, logsDir, repoDir } = stageDirs(tempDir()))
})

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return stageDeps({ featuresDir, logsDir, projectRoot: tmpDir }, over)
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return stageManifest(repoDir, over)
}

function ctxFor(m: FlightManifest) {
  return flightStageCtx(m, { logsDir })
}

describe('stage reset (R78 restart wipe)', () => {
  type PublishedEvent = { type: string; feature?: string; taskId?: string }

  function eventSink(): { events: PublishedEvent[]; publisher: { publish: (e: PublishedEvent) => void } } {
    const events: PublishedEvent[] = []
    return { events, publisher: { publish: (e) => events.push(e) } }
  }

  describe('specs-coverage.reset', () => {
    it('deletes every authored spec (incl. the seed) and the coverage state — but keeps the PRD summary', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const e2eDir = path.join(featureDir, 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      fs.writeFileSync(path.join(e2eDir, 'authored.spec.ts'), '// spec\n')
      fs.mkdirSync(path.join(e2eDir, 'phase'))
      fs.writeFileSync(path.join(e2eDir, 'phase/case.test.js'), '// nested spec')
      fs.writeFileSync(path.join(e2eDir, 'phase/helper.js'), '// helper')
      const docsDir = path.join(featureDir, 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, '_coverage-state.json'), '{}')
      fs.writeFileSync(path.join(docsDir, '_coverage-mappings.json'), '{}')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{"requirements":[]}')
      const { events, publisher } = eventSink()

      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      const specs = fs.existsSync(e2eDir) ? fs.readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts')) : []
      expect(specs).toEqual([])
      expect(fs.existsSync(path.join(e2eDir, 'phase/case.test.js'))).toBe(false)
      expect(fs.readFileSync(path.join(e2eDir, 'phase/helper.js'), 'utf8')).toBe('// helper')
      expect(fs.existsSync(path.join(docsDir, '_coverage-state.json'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, '_coverage-mappings.json'))).toBe(false)
      // An EARLIER stage's artifact — a restart at specs-coverage must not touch it.
      expect(fs.existsSync(path.join(docsDir, '_prd-summary.json'))).toBe(true)
      expect(events).toContainEqual({ type: 'tests-changed', feature: 'checkout' })
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature dir is already gone', async () => {
      const { events, publisher } = eventSink()
      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })

    it('keeps non-spec files in e2e/ and announces no tests-changed when nothing was wiped', async () => {
      // Fixtures and helpers under e2e/ are the author's, not this stage's
      // artifacts — and with no spec deleted there is no test list to refresh.
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const e2eDir = path.join(featuresDir, 'checkout', 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      for (const f of fs.readdirSync(e2eDir)) fs.rmSync(path.join(e2eDir, f), { force: true })
      fs.writeFileSync(path.join(e2eDir, 'helpers.ts'), 'export const x = 1\n')
      const { events, publisher } = eventSink()

      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.readdirSync(e2eDir)).toEqual(['helpers.ts'])
      expect(events).toEqual([{ type: 'coverage-changed', feature: 'checkout' }])
    })

    it('still clears the coverage state when e2e/ does not exist at all', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      fs.rmSync(path.join(featureDir, 'e2e'), { recursive: true, force: true })
      const docsDir = path.join(featureDir, 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, '_coverage-state.json'), '{}')
      const { events, publisher } = eventSink()

      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(path.join(docsDir, '_coverage-state.json'))).toBe(false)
      expect(events).toEqual([{ type: 'coverage-changed', feature: 'checkout' }])
    })
  })

  describe('portify.reset', () => {
    it('restores the pre-portify config from its snapshot and drops the overlay', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const original = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
      const overlayDir = path.join(featureDir, 'portify')
      fs.mkdirSync(overlayDir, { recursive: true })
      fs.writeFileSync(
        path.join(overlayDir, 'meta.json'),
        JSON.stringify({ version: 1, repos: [{ name: 'app', patchFile: 'app.patch', baseCommit: 'abc' }] }),
      )
      fs.writeFileSync(path.join(overlayDir, 'original-config.snapshot'), original)
      fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), original + '\n// portified\n')
      const { events, publisher } = eventSink()

      await portifyStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe(original)
      expect(fs.existsSync(overlayDir)).toBe(false)
      expect(events).toContainEqual({ type: 'features-changed' })
    })

    it('is a no-op when no overlay exists', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const original = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
      const { events, publisher } = eventSink()

      await portifyStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe(original)
      expect(events).toEqual([])
    })
  })

  describe('run.reset', () => {
    it('aborts a live run, then deletes the record through the runs route', async () => {
      let aborted = false
      const calls: FlightInjectCall[] = []
      const inject = fakeFlightInject((c) => {
        if (c.method === 'GET' && c.url === '/api/runs/r1') {
          return { statusCode: 200, body: { manifest: { status: aborted ? 'aborted' : 'running' } } }
        }
        if (c.method === 'POST' && c.url === '/api/runs/r1/abort') {
          aborted = true
          return { statusCode: 200, body: {} }
        }
        if (c.method === 'DELETE' && c.url === '/api/runs/r1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await runStage(deps({ inject })).reset!(ctxFor(manifest({ links: { runId: 'r1' } })).ctx)

      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/r1/abort')).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/runs/r1')).toBe(true)
    })

    it('deletes a terminal run record without aborting', async () => {
      const calls: FlightInjectCall[] = []
      const inject = fakeFlightInject((c) => {
        if (c.method === 'GET' && c.url === '/api/runs/r1') {
          return { statusCode: 200, body: { manifest: { status: 'passed' } } }
        }
        if (c.method === 'DELETE' && c.url === '/api/runs/r1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await runStage(deps({ inject })).reset!(ctxFor(manifest({ links: { runId: 'r1' } })).ctx)

      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/r1/abort')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/runs/r1')).toBe(true)
    })

    it('is a no-op without a runId link', async () => {
      const calls: FlightInjectCall[] = []
      await runStage(deps({ inject: fakeFlightInject(() => undefined, calls) })).reset!(ctxFor(manifest()).ctx)
      expect(calls).toEqual([])
    })

    it('completes even when abort, the abort wait, and the delete all fail', async () => {
      // The reset is the last thing between the user and a restart — a runs
      // route that is down must not strand the flight mid-wipe.
      const seen: string[] = []
      let gets = 0
      const inject: FlightInject = async (opts) => {
        seen.push(`${opts.method} ${opts.url}`)
        // The first read finds a live run (so the abort path is taken); every
        // later call — abort, the abort wait's re-read, and the delete — fails.
        if (opts.method === 'GET' && gets++ === 0) {
          return { statusCode: 200, json: () => ({ manifest: { status: 'running' } }) }
        }
        throw new Error('runs route is down')
      }

      await expect(
        runStage(deps({ inject })).reset!(ctxFor(manifest({ links: { runId: 'r1' } })).ctx),
      ).resolves.toBeUndefined()
      expect(seen).toEqual([
        'GET /api/runs/r1',
        'POST /api/runs/r1/abort',
        'GET /api/runs/r1',
        'DELETE /api/runs/r1',
      ])
    })
  })

  describe('evaluation-export.reset', () => {
    it('keeps a completed report downloadable when a refreshed export starts', async () => {
      createEvaluationExportTask(logsDir, {
        taskId: 'eval-ready',
        runId: 'r1',
        feature: 'checkout',
        mode: 'raw',
        status: 'completed',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:01:00.000Z',
        downloadReady: true,
        archiveBase: 'checkout-report',
      })
      const zip = path.join(logsDir, 'evaluation-exports', 'eval-ready', 'export.zip')
      fs.writeFileSync(zip, 'historical report')
      const calls: FlightInjectCall[] = []

      await evaluationExportStage(deps({ inject: fakeFlightInject(() => undefined, calls) })).reset!(
        ctxFor(manifest({ links: { runId: 'r1', evaluationTaskId: 'eval-ready' } })).ctx,
      )

      expect(calls).toEqual([])
      expect(fs.readFileSync(zip, 'utf8')).toBe('historical report')
    })

    it('deletes the export task through the evaluation route', async () => {
      const calls: FlightInjectCall[] = []
      const inject = fakeFlightInject((c) => {
        if (c.method === 'DELETE' && c.url === '/api/evaluation-exports/t1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await evaluationExportStage(deps({ inject })).reset!(
        ctxFor(manifest({ links: { runId: 'r1', evaluationTaskId: 't1' } })).ctx,
      )

      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/evaluation-exports/t1')).toBe(true)
    })

    it('swallows a DELETE that fails — reset must not block the restart', async () => {
      const inject: FlightInject = async () => { throw new Error('evaluation route is down') }
      await expect(
        evaluationExportStage(deps({ inject })).reset!(
          ctxFor(manifest({ links: { runId: 'r1', evaluationTaskId: 't1' } })).ctx,
        ),
      ).resolves.toBeUndefined()
    })

    it('is a no-op without an evaluationTaskId link', async () => {
      const calls: FlightInjectCall[] = []
      await evaluationExportStage(deps({ inject: fakeFlightInject(() => undefined, calls) })).reset!(
        ctxFor(manifest({ links: { runId: 'r1' } })).ctx,
      )
      expect(calls).toEqual([])
    })
  })
})
