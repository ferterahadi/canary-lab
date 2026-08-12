import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

// Transparent pass-through by default — every other test in this file spawns
// real processes (fake npx/claude binaries on PATH). Only the one test below
// that needs to control child-process event ordering deterministically
// installs an override via setMockSpawn.
const { getMockSpawn, setMockSpawn } = vi.hoisted(() => {
  let impl: ((...args: unknown[]) => unknown) | null = null
  return {
    getMockSpawn: () => impl,
    setMockSpawn: (fn: ((...args: unknown[]) => unknown) | null) => { impl = fn },
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const impl = getMockSpawn()
      return impl ? impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { scaffoldStage } from './scaffold'

import { envCaptureStage } from './env-capture'

import { attemptLogLine, describeAttempt, docsStage } from './docs'

import { prdSummaryStage } from './prd-summary'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { stageContextStub } from './__fixtures__/stage-context'

let tmpDir: string

let featuresDir: string

let logsDir: string

let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-stages-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

type InjectCall = { method: string; url: string; payload?: unknown }

type InjectImpl = (call: InjectCall) => { statusCode: number; body: unknown } | undefined

function makeInject(impl: InjectImpl, calls: InjectCall[] = []): FlightInject {
  return async (opts) => {
    calls.push(opts)
    const out = impl(opts) ?? { statusCode: 500, body: { error: `unstubbed ${opts.method} ${opts.url}` } }
    return { statusCode: out.statusCode, json: () => out.body }
  }
}

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    inject: makeInject(() => undefined),
    ...over,
  }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'similarity',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void; progressLog: unknown[] } {
  const state = { m }
  const progressLog: unknown[] = []
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  return {
    progressLog,
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      setProgress: (progress) => { progressLog.push(progress) },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    }),
    current: () => state.m,
    setStage,
  }
}

describe('stage reset (R78 restart wipe)', () => {
  type PublishedEvent = { type: string; feature?: string; taskId?: string }

  function eventSink(): { events: PublishedEvent[]; publisher: { publish: (e: PublishedEvent) => void } } {
    const events: PublishedEvent[] = []
    return { events, publisher: { publish: (e) => events.push(e) } }
  }

  describe('scaffold.reset', () => {
    it('deletes the feature dir + marker when the marker proves this flight created it', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const { ctx } = ctxFor(manifest())
      fs.mkdirSync(ctx.flightDir, { recursive: true })
      fs.writeFileSync(path.join(ctx.flightDir, 'scaffolded-feature'), 'checkout')
      const { events, publisher } = eventSink()

      await scaffoldStage(deps({ workspaceEvents: publisher })).reset!(ctx)

      expect(fs.existsSync(featureDir)).toBe(false)
      expect(fs.existsSync(path.join(ctx.flightDir, 'scaffolded-feature'))).toBe(false)
      expect(events).toContainEqual({ type: 'feature-deleted', feature: 'checkout' })
    })

    it('leaves a PRE-EXISTING feature alone (no marker — the enhance path)', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const { ctx } = ctxFor(manifest())
      const { events, publisher } = eventSink()

      await scaffoldStage(deps({ workspaceEvents: publisher })).reset!(ctx)

      expect(fs.existsSync(featureDir)).toBe(true)
      expect(events).toEqual([])
    })

    it('drops the marker without announcing a deletion when the feature is already gone', async () => {
      // The marker claims this flight scaffolded `checkout`, but the dir was
      // removed out-of-band — no feature-deleted event may be published for a
      // deletion that did not happen, and the stale marker still has to go.
      const { ctx } = ctxFor(manifest())
      fs.mkdirSync(ctx.flightDir, { recursive: true })
      fs.writeFileSync(path.join(ctx.flightDir, 'scaffolded-feature'), 'checkout')
      const { events, publisher } = eventSink()

      await scaffoldStage(deps({ workspaceEvents: publisher })).reset!(ctx)

      expect(events).toEqual([])
      expect(fs.existsSync(path.join(ctx.flightDir, 'scaffolded-feature'))).toBe(false)
    })

    it('leaves a feature alone when the marker names a DIFFERENT feature', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const { ctx } = ctxFor(manifest())
      fs.mkdirSync(ctx.flightDir, { recursive: true })
      fs.writeFileSync(path.join(ctx.flightDir, 'scaffolded-feature'), 'other-feature')

      await scaffoldStage(deps()).reset!(ctx)

      expect(fs.existsSync(path.join(featuresDir, 'checkout'))).toBe(true)
    })
  })

  describe('env-capture.reset', () => {
    it("removes the captured envset for the flight's env", async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const envsetDir = path.join(featuresDir, 'checkout', 'envsets', 'local')
      fs.mkdirSync(envsetDir, { recursive: true })
      fs.writeFileSync(path.join(envsetDir, '.env'), 'API_KEY=secret\n')
      const { events, publisher } = eventSink()

      await envCaptureStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(envsetDir)).toBe(false)
      expect(events).toContainEqual({ type: 'envsets-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature dir is already gone', async () => {
      const { events, publisher } = eventSink()
      await envCaptureStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })
  })

  describe('docs.reset', () => {
    it('wipes the ENTIRE docs dir — user files, symlinks, generated artifacts (user ruling)', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const docsDir = path.join(featuresDir, 'checkout', 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      const userPrd = path.join(tmpDir, 'my-own-prd.md')
      fs.writeFileSync(userPrd, '# my prd\n')
      fs.writeFileSync(path.join(docsDir, 'hand-added.md'), '# notes\n')
      fs.symlinkSync(userPrd, path.join(docsDir, 'my-own-prd.md'))
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{}')
      const { events, publisher } = eventSink()

      await docsStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(docsDir)).toBe(false)
      // The symlink TARGET (the user's own file) is never touched.
      expect(fs.existsSync(userPrd)).toBe(true)
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when there is no docs dir', async () => {
      const { events, publisher } = eventSink()
      await docsStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })
  })

  describe('prd-summary.reset', () => {
    it('clears the PRD summary artifacts but keeps user docs', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const docsDir = path.join(featuresDir, 'checkout', 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, 'hand-added.md'), '# notes\n')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{"requirements":[]}')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.md'), '# summary\n')
      const { events, publisher } = eventSink()

      await prdSummaryStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(path.join(docsDir, '_prd-summary.json'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, '_prd-summary.md'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, 'hand-added.md'))).toBe(true)
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature is already gone (redo wiped it earlier in the pass)', async () => {
      await expect(prdSummaryStage(deps()).reset!(ctxFor(manifest()).ctx)).resolves.toBeUndefined()
    })
  })
})
