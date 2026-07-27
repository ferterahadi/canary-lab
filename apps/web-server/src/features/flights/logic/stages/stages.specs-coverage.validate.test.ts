import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import { EventEmitter } from 'events'

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

import { buildSpecsPrompt, specsCoverageStage, defaultValidateSpecs, tscErrorsForFeature } from './specs-coverage'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'

import type { CoverageLedger } from '../../../../../../../shared/coverage/types'

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
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      signal: new AbortController().signal,
      appendLog: () => {},
      setProgress: (progress) => { progressLog.push(progress) },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    },
    current: () => state.m,
    setStage,
  }
}

describe('specs-coverage stage', () => {
  const SPEC = `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'\n\ntest('checkout @req-R1 @path-happy', async ({ page }) => { expect(1).toBe(1) })\n`

  function ledger(pct: number): CoverageLedger {
    return {
      feature: 'checkout',
      requirements: pct >= 100 ? [] : [{ requirement: { id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }, annotatedTestNames: [], pathCoverage: [], gapType: 'untested', coverageStatus: 'uncovered' }],
      tests: [],
      totals: { total: 1, covered: pct >= 100 ? 1 : 0, pathIncomplete: 0, variantIncomplete: 0, untested: pct >= 100 ? 0 : 1, orphanTests: 0 },
      coveragePct: pct,
      mappedPct: pct,
      orphanRequirementIds: [],
      orphanTestNames: [],
    }
  }

  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], docsHash: 'h', sourceDocs: [], generatedAt: new Date().toISOString() }),
    )
  })

  // The agent edits <featureDir>/e2e/*.spec.ts in place — the mock spawn
  // writes to disk like the real agent's Write tool would.
  function writingSpawnAgent(prompts: string[], content = SPEC): FlightStageDeps['spawnAgent'] {
    return async (opts) => {
      prompts.push(opts.prompt)
      const e2eDir = path.join(featuresDir, 'checkout', 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      fs.writeFileSync(path.join(e2eDir, 'checkout.spec.ts'), content)
      return { text: 'rewrote e2e/checkout.spec.ts' }
    }
  }

  describe('defaultValidateSpecs (real dry-run: fake npx on PATH)', () => {
    const ORIGINAL_PATH = process.env.PATH

    afterEach(() => {
      process.env.PATH = ORIGINAL_PATH
    })

    // A fake `npx` on PATH that dispatches on its args so we exercise the
    // real spawn/stdout/stderr/close plumbing in tscErrorsForFeature and the
    // playwright --list branch, without invoking the real CLIs.
    function fakeNpxOnPath(behavior: {
      playwright?: { exit: number; stdout?: string }
      tsc?: { exit: number; stdout?: string }
    }): void {
      const binDir = path.join(tmpDir, 'fake-bin')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        'case "$*" in',
        behavior.playwright
          ? `  *"playwright test --list"*) ${behavior.playwright.stdout ? `printf '%s' '${behavior.playwright.stdout.replace(/'/g, "'\\''")}'` : ':'}; exit ${behavior.playwright.exit} ;;`
          : '',
        behavior.tsc
          ? `  *"tsc --noEmit"*) ${behavior.tsc.stdout ? `printf '%s' '${behavior.tsc.stdout.replace(/'/g, "'\\''")}'` : ':'}; exit ${behavior.tsc.exit} ;;`
          : '',
        '  *) exit 0 ;;',
        'esac',
      ].filter(Boolean).join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      process.env.PATH = `${binDir}:${ORIGINAL_PATH}`
    }

    it('reports clean when playwright lists fine and tsc has no tsconfig', async () => {
      fakeNpxOnPath({ playwright: { exit: 0, stdout: '{"suites":[]}' } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('reports clean when tsc exits 0 (no compile errors)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      fakeNpxOnPath({ playwright: { exit: 0, stdout: '{"suites":[]}' }, tsc: { exit: 0 } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('surfaces feature-scoped tsc errors and ignores errors outside the feature dir', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const inFeature = `${path.join(featureDir, 'e2e', 'checkout.spec.ts')}(3,1): error TS2304: Cannot find name 'foo'.`
      const outsideFeature = `${path.join(tmpDir, 'other.ts')}(1,1): error TS1000: unrelated.`
      fakeNpxOnPath({
        playwright: { exit: 0, stdout: '{"suites":[]}' },
        tsc: { exit: 2, stdout: `${inFeature}\n${outsideFeature}\n` },
      })
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.errors).toContain('TS2304')
      expect(result.errors).not.toContain('TS1000')
    })

    it('accumulates tsc errors emitted on stderr too (not just stdout)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const inFeature = `${path.join(featureDir, 'e2e', 'checkout.spec.ts')}(3,1): error TS2304: Cannot find name 'foo'.`
      const binDir = path.join(tmpDir, 'fake-bin-stderr')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        'case "$*" in',
        `  *"playwright test --list"*) printf '%s' '{"suites":[]}'; exit 0 ;;`,
        `  *"tsc --noEmit"*) printf '%s' '${inFeature.replace(/'/g, "'\\''")}\\n' 1>&2; exit 2 ;;`,
        '  *) exit 0 ;;',
        'esac',
      ].join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}:${originalPath}`
      try {
        const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.errors).toContain('TS2304')
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('treats a tsc spawn error (npx not found on PATH) as clean (a missing tool is not a spec failure)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // No fake npx on PATH at all, and PATH cleared entirely — the `spawn('npx', ...)`
      // call itself fails to find the binary, firing the child's 'error' event
      // (as opposed to a non-zero exit code from a found-but-failing binary).
      const originalPath = process.env.PATH
      process.env.PATH = path.join(tmpDir, 'empty-bin-dir')
      fs.mkdirSync(process.env.PATH, { recursive: true })
      try {
        const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
        // playwright --list also fails to spawn (same empty PATH) — that's a
        // real problem — but the tsc side specifically must resolve to null
        // (not compound the error), which this asserts indirectly via ok:false
        // carrying only the playwright message, never a tsc one.
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.errors).not.toContain('tsc --noEmit')
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('treats a non-zero tsc exit with no feature-scoped error lines as clean', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // tsc exits non-zero, but every error line falls outside the feature dir.
      const outsideOnly = `${path.join(tmpDir, 'other.ts')}(1,1): error TS1000: unrelated.`
      fakeNpxOnPath({
        playwright: { exit: 0, stdout: '{"suites":[]}' },
        tsc: { exit: 2, stdout: `${outsideOnly}\n` },
      })
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('reports a playwright --list failure as a problem', async () => {
      fakeNpxOnPath({ playwright: { exit: 1, stdout: '' } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.errors).toContain('playwright test --list exited with code 1')
    })

    it('kills a hung tsc process at the timeout and treats it as clean (a stuck tool is not a spec failure)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const binDir = path.join(tmpDir, 'fake-bin-hang')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        // Never exits on its own — only the injected timeout's SIGKILL ends it.
        'sleep 999999',
      ].join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      process.env.PATH = `${binDir}:${ORIGINAL_PATH}`
      // A real (tiny) timeout — no fake-timer/real-child-process races.
      const result = await tscErrorsForFeature(tmpDir, featureDir, 50)
      expect(result).toBeNull()
    })

    it('ignores a late "error" event that arrives after the process already settled', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // A fake child whose 'close' fires first (settling the promise), then a
      // stray 'error' arrives afterward — the error handler's own settled
      // guard must no-op rather than double-resolve.
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {},
      })
      setMockSpawn(() => fakeChild)
      try {
        const resultPromise = tscErrorsForFeature(tmpDir, featureDir, 60_000)
        fakeChild.emit('close', 0)
        fakeChild.emit('error', new Error('late, after close'))
        const result = await resultPromise
        expect(result).toBeNull()
      } finally {
        setMockSpawn(null)
      }
    })
  })

  it('meets target on the very last post-iteration compute (post-loop check, not the top-of-loop one)', async () => {
    // 1 initial compute + 5 end-of-iteration computes = 6 calls; only the 6th
    // (last) meets target, so the for-loop runs out before its own top-of-loop
    // check ever sees 100% — only the post-loop targetMet(...) check does.
    let calls = 0
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: ((() => {
          calls += 1
          return calls >= 6 ? ledger(100) : ledger(0)
        }) as unknown) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const outcome = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    expect(calls).toBe(6)
  })

  it('buildSpecsPrompt renders the edit-in-place contract and caps injected validation errors', () => {
    const base = {
      feature: 'checkout',
      description: 'checkout flow',
      configPath: '/abs/features/checkout/feature.config.cjs',
      requirements: [{ id: 'R1' }],
      gaps: [{ id: 'R1', title: 't', gap: 'untested' }],
      featureDir: '/abs/features/checkout',
      iteration: 1,
    }
    const clean = buildSpecsPrompt(base)
    expect(clean).toContain('/abs/features/checkout/e2e')
    expect(clean).toContain('Do NOT reply with JSON')
    expect(clean).not.toContain('failed to compile/list')
    expect(clean).not.toContain('{{')

    const huge = 'x'.repeat(5000) + 'OVERFLOW-MARKER'
    const withErrors = buildSpecsPrompt({ ...base, iteration: 2, validationErrors: huge })
    expect(withErrors).toContain('failed to compile/list')
    expect(withErrors).toContain('xxxx')
    expect(withErrors).not.toContain('OVERFLOW-MARKER')
  })
})
