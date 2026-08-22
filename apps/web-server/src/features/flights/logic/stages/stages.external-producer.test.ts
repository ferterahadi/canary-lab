import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scoutStage } from './scout'
import { docsStage } from './docs'
import { specsCoverageStage } from './specs-coverage'
import { prdSummaryStage } from './prd-summary'
import type { FlightStageDeps } from './context'
import type { StageContext, StageOutcome } from '../conductor'
import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'
import { stageContextStub } from './__fixtures__/stage-context'

// The hand-off path: `opts.stageProducer === 'external'` makes the thinking
// stages (scout, docs, prd-summary, specs↔coverage) park on an `external-work`
// checkpoint instead of spawning a local
// CLI, and their responders settle from what the CLIENT left on disk.
//
// The property under test throughout is that the hand-off changes WHO does the
// work and nothing about how the result is judged: the same validation runs, so a
// client that claims success without writing files fails exactly as a local agent
// would.

let tmpDir: string
let featuresDir: string
let logsDir: string
let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-external-producer-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  for (const d of [featuresDir, logsDir, repoDir]) fs.mkdirSync(d, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    inject: (async () => ({ statusCode: 500, json: () => ({ error: 'unstubbed' }) })) as unknown as FlightStageDeps['inject'],
    // Any spawn reaching this is a BUG in the hand-off path — the point is that no
    // local agent runs when the client owns the step.
    spawnAgent: async () => { throw new Error('spawnAgent must not run for an external producer') },
    ...over,
  }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-ext',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
    status: 'running',
    currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; setStage: (k: FlightStageKey, p: Partial<FlightStage>) => void; logs: string[] } {
  const state = { m }
  const logs: string[] = []
  return {
    logs,
    setStage: (key, patch) => {
      state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
    },
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', 'fl-ext'),
      appendLog: (c) => { logs.push(c) },
      patchFlight: () => {},
    }),
  }
}

/** The checkpoint a hand-off parks on, or a failure if it did something else. */
function handOffOf(outcome: StageOutcome): { kind: string; data: Record<string, unknown>; options?: string[] } {
  expect(outcome.kind).toBe('checkpoint')
  const cp = (outcome as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint
  return { kind: cp.kind, data: (cp.data ?? {}) as Record<string, unknown>, ...(cp.options ? { options: cp.options } : {}) }
}

const CONFIG_SOURCE = "const config = {\n  name: 'checkout',\n  envs: ['local'],\n  repos: [],\n}\nmodule.exports = { config }\n"

describe('scout — external producer', () => {
  it('parks with the same prompt the local agent would have run, instead of spawning', async () => {
    const { ctx } = ctxFor(manifest())
    const cp = handOffOf(await scoutStage(deps()).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('scout')
    // The rendered scout prompt, fan-out rule included — not a bespoke summary.
    expect(String(cp.data.prompt)).toContain('feature.config.cjs')
    expect(String(cp.data.prompt)).toContain('Fan out when there is more than one repo')
    expect(cp.options).toEqual(['submit', 'run-internally'])
  })

  it('accepts a submitted draft and holds it to the SAME config-parse validation', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const ok = await scoutStage(deps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { configSource: CONFIG_SOURCE, envFiles: ['/repo/.env'] },
    })
    expect(ok).toMatchObject({ kind: 'done', evidence: { envFiles: ['/repo/.env'] } })
  })

  it('parses a submitted draft handed back as a JSON string', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const ok = await scoutStage(deps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: '```json\n' + JSON.stringify({ configSource: CONFIG_SOURCE, envFiles: [] }) + '\n```',
    })
    expect(ok).toMatchObject({ kind: 'done' })
  })

  // Live-flight finding: settling `failed` here poisons the stage, because the
  // checkpointResponse persists and a resume REPLAYS it — the flight then fails
  // identically forever and only a full redo clears it. A rejection must re-park.
  it('RE-PARKS a draft whose config does not parse, carrying the reason', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const bad = await scoutStage(deps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { configSource: 'this is not a config', envFiles: [] },
    })
    const cp = handOffOf(bad)
    expect(cp.kind).toBe('external-work')
    expect((cp.data.context as { lastRejection: string }).lastRejection).toMatch(/does not parse/)
  })

  it('re-parks when the client submits nothing at all', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const cp = handOffOf(await scoutStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' }))
    expect(cp.kind).toBe('external-work')
    expect((cp.data.context as { lastRejection: string }).lastRejection).toBe('no draft was submitted')
  })

  it('a re-park keeps the flight advanceable — the next, valid submit settles it', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const adapter = scoutStage(deps())
    await adapter.onCheckpointResponse!(ctx, { choice: 'submit', data: { configSource: 'nope', envFiles: [] } })
    // Still parked on external-work, so the client can simply answer again.
    const ok = await adapter.onCheckpointResponse!(ctx, { choice: 'submit', data: { configSource: CONFIG_SOURCE, envFiles: [] } })
    expect(ok).toMatchObject({ kind: 'done' })
  })

  it('drops non-string entries out of a submitted envFiles list', async () => {
    const { ctx, setStage } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const ok = await scoutStage(deps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { configSource: CONFIG_SOURCE, envFiles: ['/a/.env', 42, null] },
    })
    expect(ok).toMatchObject({ kind: 'done', evidence: { envFiles: ['/a/.env'] } })
  })

  it('runs locally when the client hands the step back', async () => {
    const { ctx, setStage, logs } = ctxFor(manifest())
    setStage('scout', { checkpoint: { kind: 'external-work', message: 'x' } })
    const ranWith: string[] = []
    const d = deps({
      spawnAgent: async ({ prompt }) => { ranWith.push(prompt); return { text: JSON.stringify({ configSource: CONFIG_SOURCE, envFiles: [] }) } },
    })
    expect(await scoutStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({ kind: 'done' })
    expect(ranWith).toHaveLength(1)
    expect(logs.join('')).toContain('handed the step back')
  })
})

describe('docs — external producer', () => {
  const docsManifest = () => manifest({ currentStage: 'docs' })

  /** Release the human prd-source fork by choosing a collector path. */
  const chooseCollector = async (d: FlightStageDeps, ctx: StageContext, mode: 'collect-repo-docs' | 'infer-from-diff' = 'collect-repo-docs') =>
    docsStage(d).onCheckpointResponse!(ctx, { choice: mode })

  it('hands the collector step to the client instead of spawning one', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    setStage('docs', { checkpoint: { kind: 'prd-source', message: 'fork' } })
    const cp = handOffOf(await chooseCollector(deps(), ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('docs')
    const context = cp.data.context as { mode: string; outPath: string; outName: string }
    expect(context.mode).toBe('collect-repo-docs')
    expect(context.outName).toBe('checkout-prd.md')
    expect(String(cp.data.prompt)).toContain('Fan out the search when there is more than one repo')
  })

  it('discards a docs submit answering a superseded hand-off', async () => {
    // Same guarantee as scout's, but docs parks the hand-off from its OWN responder
    // rather than through the wrapper — so it needs its own gate, and its own proof
    // that the gate is wired.
    const { ctx, setStage } = ctxFor(docsManifest())
    setStage('docs', {
      checkpoint: {
        kind: 'external-work',
        message: 'x',
        data: { mode: 'collect-repo-docs', outPath: '/tmp/nope.md', outName: 'nope.md', handOffId: 'live-id' },
      },
    })
    const outcome = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('settles from the doc the CLIENT wrote — not from what it claims', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, '# Requirements\n- must check out\n')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } } })
    const settled = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote it' })
    expect(settled).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs' } })
  })

  it('re-parks when the client claims success but wrote no file', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } } })
    const cp = handOffOf(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 'all done!' }))
    // Straight back to the human fork, carrying the empty-handed verdict.
    expect(cp.kind).toBe('prd-source')
    expect((cp.data.lastAttempt as { outcome: string }).outcome).toBe('no-output')
  })

  it('mines a NOTHING_FOUND reason out of the client reply', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'x.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'infer-from-diff', outPath, outName: 'x.md' } } } })
    const cp = handOffOf(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 'NOTHING_FOUND: the diff is all formatting' }))
    expect(cp.data.lastAttempt).toMatchObject({ outcome: 'empty', reason: 'the diff is all formatting' })
  })

  // `data` is only ever mined for a NOTHING_FOUND reason, so its SHAPE must never
  // decide anything — a client that replies with a structured object, or with
  // nothing at all, is judged purely on the file it left behind.
  it.each([
    ['a structured object', { wrote: 'checkout-prd.md', sections: 3 } as unknown],
    ['no data at all', undefined],
  ])('settles from disk regardless of the reply shape: %s', async (_label, data) => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, '# Requirements\n- must check out\n')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } } })
    expect(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', ...(data === undefined ? {} : { data }) })).toMatchObject({
      kind: 'done',
      evidence: { source: 'agent-repo-docs' },
    })
  })

  // An external submission must never settle `failed`: checkpointResponse
  // persists, so a resume replays the same answer and fails identically —
  // unrecoverable without a full redo. A hand-off with no output path is
  // unjudgeable, so the stage re-asks with a fresh one instead.
  it('re-parks a fresh hand-off when the previous one lost its output path', async () => {
    const { ctx, setStage, logs } = ctxFor(docsManifest())
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'collect-repo-docs' } } } })
    const out = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })
    expect(out).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'external-work' } })
    const context = (out as { checkpoint: { data?: { context?: { outPath?: string } } } }).checkpoint.data?.context
    expect(context?.outPath).toBeTruthy()
    expect(logs.join('')).toContain('lost its output path')
  })

  it('collects locally when the client hands the step back', async () => {
    const { ctx, setStage, logs } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } } })
    const d = deps({
      spawnAgent: async () => { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, '# reqs\n'); return { text: 'done' } },
    })
    expect(await docsStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({ kind: 'done' })
    expect(logs.join('')).toContain('handed the step back')
  })

  it('defaults a hand-off with no recorded mode to the repo-docs collector', async () => {
    const { ctx, setStage, logs } = ctxFor(docsManifest())
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: {} } })
    const out = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })
    // No outPath either, so it re-parks — and the re-ask names the default mode.
    expect(out).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'external-work' } })
    expect(logs.join('')).toContain('collect repo docs')
  })
})

describe('specs-coverage — external producer', () => {
  const ledger = (pct: number) => ({
    coveragePct: pct,
    totals: { covered: pct, total: 100 },
    requirements: pct >= 100 ? [] : [{ requirement: { id: 'R1', title: 'checkout works' }, gapType: 'untested' }],
  })

  const specsDeps = (over: Partial<FlightStageDeps> = {}): FlightStageDeps => {
    const featureDir = path.join(featuresDir, 'checkout')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 'checkout works', text: 'it works', pathTypes: ['happy'] }] }),
    )
    return deps({
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => ledger(0)) as unknown as never,
        runEngine: (async () => ({})) as unknown as never,
      },
      ...over,
    })
  }

  it('hands one authoring pass to the client, carrying the pass state', async () => {
    const { ctx } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    const cp = handOffOf(await specsCoverageStage(specsDeps()).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('specs-coverage')
    const context = cp.data.context as { pass: { iteration: number }; target: number }
    expect(context.pass.iteration).toBe(1)
    expect(context.target).toBe(100)
    expect(String(cp.data.prompt)).toContain('Fan out when the gaps span more than one spec file')
  })

  // Fixtures place `pass` under data.context — the shape externalWorkCheckpoint
  // actually emits. Hand-built checkpoints that put it at data.pass masked a
  // real bug (the responder read the wrong key and every round resumed at pass
  // 1); the round-trip test below pins the emitter→responder agreement.
  it('settles on the recomputed ledger when the client\'s specs close the gap', async () => {
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { pass: { iteration: 1, validationErrors: '', passes: [] } } } } })
    // Fresh compute on resume sees 100% — the CLIENT's files raised it, and the
    // ledger (not the client's word) is what settles the stage.
    const d = specsDeps({ coverage: { compute: (() => ledger(100)) as unknown as never, runEngine: (async () => ({})) as unknown as never } })
    const out = await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote 3 specs' })
    expect(out).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
  })

  it('discards a specs submit answering a superseded hand-off', async () => {
    // The third stage that parks this kind, and the one where a stale submit is
    // most costly: it would settle an authoring pass off a ledger recomputed for a
    // different ask.
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', {
      checkpoint: {
        kind: 'external-work',
        message: 'x',
        data: { context: { pass: { iteration: 1, validationErrors: '', passes: [] } }, handOffId: 'live-id' },
      },
    })
    const out = await specsCoverageStage(specsDeps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })
    expect(out).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('hands the pass back to the local agent on run-internally, keeping the pass number', async () => {
    const { ctx, setStage, logs } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { pass: { iteration: 2, validationErrors: '', passes: [] } } } } })
    // Coverage stays short, so the taken-back pass actually authors (a 100% ledger
    // would settle at the head of runPass before any spawn) and the loop then runs
    // out its remaining rounds and parks on coverage-stuck.
    const prompts: string[] = []
    const d = specsDeps({ spawnAgent: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } } })
    const out = await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(logs.join('')).toContain('handed pass 2 back')
    // Resumed AT pass 2, not restarted at 1 — the pass number survived the park.
    expect(prompts[0]).toContain('iteration 2')
    // `run-internally` takes back exactly ONE pass, not the whole stage: the flight
    // is still stage_producer:"external", so the NEXT pass hands off again. Taking a
    // step back is a per-step escape hatch, not a mode switch.
    expect(prompts).toHaveLength(1)
    const next = handOffOf(out)
    expect(next.kind).toBe('external-work')
    expect((next.data.context as { pass: { iteration: number } }).pass.iteration).toBe(3)
  })

  it('fails the resume when the PRD summary went missing while parked', async () => {
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { pass: { iteration: 1, validationErrors: '', passes: [] } } } } })
    const d = specsDeps()
    fs.rmSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), { force: true })
    expect(await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({ kind: 'failed' })
  })

  it('defaults to pass 1 when the hand-off carried no pass state', async () => {
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: {} } })
    const d = specsDeps({ coverage: { compute: (() => ledger(100)) as unknown as never, runEngine: (async () => ({})) as unknown as never } })
    expect(await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({ kind: 'done' })
  })
})

describe('prd-summary — external producer', () => {
  /** A discoverable feature (loadFeatures needs the config) with one source doc,
   *  so buildSummaryAuthoringContext has something to hand off and
   *  applyExternalSummary can resolve the feature dir. */
  const writeFeature = (opts: { docs?: boolean } = {}): string => {
    const dir = path.join(featuresDir, 'checkout')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
    )
    if (opts.docs !== false) {
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item\n')
    }
    return dir
  }

  const summaryOnDisk = () =>
    JSON.parse(fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), 'utf-8')) as {
      requirements: Array<{ id: string; title: string; deprecated?: boolean }>
    }

  /** deps whose internal engine must never run — the external pin, mirroring
   *  the file-level spawnAgent throw for the stages that spawn directly. */
  const prdDeps = (over: Partial<FlightStageDeps> = {}): FlightStageDeps =>
    deps({
      coverage: {
        regenerate: (async () => { throw new Error('regenerate must not run for an external producer') }) as unknown as never,
      },
      ...over,
    })

  const prdManifest = () => manifest({ currentStage: 'prd-summary' })

  const REQUIREMENT = { title: 'create todo', text: 'a user can create a new todo item', pathTypes: ['happy'] }

  it('parks with the summary engine\'s own prompt and context instead of spawning', async () => {
    writeFeature()
    const { ctx } = ctxFor(prdManifest())
    const cp = handOffOf(await prdSummaryStage(prdDeps()).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('prd-summary')
    // The internal summarizer's prompt (prompts/prd-summary.md), not a summary.
    expect(String(cp.data.prompt)).toContain('Turn source documents into requirements')
    const context = cp.data.context as { docs: Array<{ relPath: string }>; previousRequirementIds: string[] }
    expect(context.docs.map((d) => d.relPath)).toEqual(['spec.md'])
    expect(context.previousRequirementIds).toEqual([])
    expect(cp.options).toEqual(['submit', 'run-internally'])
  })

  it('reuses a fresh summary before any hand-off', async () => {
    const dir = writeFeature()
    fs.writeFileSync(
      path.join(dir, 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], generatedAt: '2999-01-01T00:00:00Z' }),
    )
    const out = await prdSummaryStage(prdDeps()).run(ctxFor(prdManifest()).ctx)
    expect(out).toMatchObject({ kind: 'done', evidence: { requirementCount: 1, reused: true } })
  })

  it('fails (not parks) when there are no docs to summarize — a client cannot conjure sources', async () => {
    writeFeature({ docs: false })
    const out = await prdSummaryStage(prdDeps()).run(ctxFor(prdManifest()).ctx)
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('no requirement docs') })
  })

  it('applies a submitted requirements list through the canonical assembler and settles from disk', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const out = await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { requirements: [REQUIREMENT] },
    })
    expect(out).toMatchObject({ kind: 'done', evidence: { requirementCount: 1 } })
    // The evidence is the file Canary assembled, not the submission echoed back.
    expect(summaryOnDisk().requirements[0]).toMatchObject({ title: 'create todo' })
  })

  it('parses a submission handed back as a JSON string', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const out = await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: '```json\n' + JSON.stringify({ requirements: [REQUIREMENT] }) + '\n```',
    })
    expect(out).toMatchObject({ kind: 'done', evidence: { requirementCount: 1 } })
  })

  it('preserves a surviving requirement id across an external resubmit', async () => {
    const dir = writeFeature()
    fs.writeFileSync(
      path.join(dir, 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 'create todo', text: 'old text', pathTypes: ['happy'] }], generatedAt: '2020-01-01T00:00:00Z' }),
    )
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const out = await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { requirements: [{ id: 'R1', ...REQUIREMENT }] },
    })
    expect(out).toMatchObject({ kind: 'done' })
    expect(summaryOnDisk().requirements.find((r) => !r.deprecated)?.id).toBe('R1')
  })

  it('RE-PARKS an empty requirements list before anything lands on disk', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const cp = handOffOf(await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { requirements: [] },
    }))
    expect(cp.kind).toBe('external-work')
    expect(String((cp.data.context as { lastRejection: string }).lastRejection)).toContain('requirements')
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'))).toBe(false)
  })

  it('re-parks a submission missing required requirement fields, naming the first', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const cp = handOffOf(await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { requirements: [{ title: 'only a title' }] },
    }))
    expect(cp.kind).toBe('external-work')
    expect(String((cp.data.context as { lastRejection: string }).lastRejection)).toContain('requirements.0')
  })

  it('re-parks an unparseable string submission', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const cp = handOffOf(await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: 'no json here at all',
    }))
    expect(cp.kind).toBe('external-work')
    expect((cp.data.context as { lastRejection: string }).lastRejection).toBe('the submission was not parseable JSON')
  })

  it('discards a submit answering a superseded hand-off', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x', data: { handOffId: 'live-id' } } })
    const out = await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })
    expect(out).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('runs the engine locally when the client hands the step back', async () => {
    const dir = writeFeature()
    const { ctx, setStage, logs } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const d = deps({
      coverage: {
        regenerate: (async () => {
          fs.writeFileSync(
            path.join(dir, 'docs', '_prd-summary.json'),
            JSON.stringify({ requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], generatedAt: '2999-01-01T00:00:00Z' }),
          )
        }) as unknown as never,
      },
    })
    expect(await prdSummaryStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({
      kind: 'done',
      evidence: { requirementCount: 1 },
    })
    expect(logs.join('')).toContain('handed the step back')
  })

  it('carries a submitted variantDimension through the canonical assembler', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const out = await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      data: { requirements: [{ ...REQUIREMENT, variants: ['email', 'sms'] }], variantDimension: { name: 'channel', values: ['email', 'sms'] } },
    })
    expect(out).toMatchObject({ kind: 'done' })
    const written = JSON.parse(fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), 'utf-8')) as { variantDimension?: { name: string } }
    expect(written.variantDimension?.name).toBe('channel')
  })

  it('re-parks a non-object submission with the top-level reason (no field path to name)', async () => {
    writeFeature()
    const { ctx, setStage } = ctxFor(prdManifest())
    setStage('prd-summary', { checkpoint: { kind: 'external-work', message: 'x' } })
    const cp = handOffOf(await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 42 }))
    expect(cp.kind).toBe('external-work')
    expect(typeof (cp.data.context as { lastRejection: string }).lastRejection).toBe('string')
  })

  it('a replayed answer with nothing parked re-runs the stage (parks a fresh hand-off)', async () => {
    writeFeature()
    const { ctx } = ctxFor(prdManifest())
    const cp = handOffOf(await prdSummaryStage(prdDeps()).onCheckpointResponse!(ctx, { choice: 'submit' }))
    expect(cp.kind).toBe('external-work')
  })
})

describe('specs-coverage mapping — external producer', () => {
  const ledger = (pct: number) => ({
    coveragePct: pct,
    totals: { covered: pct, total: 100 },
    requirements: pct >= 100 ? [] : [{ requirement: { id: 'R1', title: 'checkout works' }, gapType: 'untested' }],
  })

  const TEST_NAME = 'create makes a new todo item'

  // The marker import is load-bearing: the authoring-submit path re-validates
  // what is on disk via applyExternalDraftFiles, which rejects a spec without it.
  const SPEC = [
    "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'",
    `test('${TEST_NAME}', async () => { expect(1).toBe(1) })`,
    '',
  ].join('\n')

  /** A REAL feature (config + spec + summary): the mapping half resolves the
   *  feature dir, collects the tests for the roster, and writes tags through
   *  the canonical tag-writer — none of which a bare docs dir can serve. */
  const fullFeature = (): string => {
    const dir = path.join(featuresDir, 'checkout')
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
    )
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), SPEC)
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 'checkout works', text: 'it works', pathTypes: ['happy'] }], generatedAt: '2020-01-01T00:00:00Z' }),
    )
    return dir
  }

  const mapDeps = (over: Partial<FlightStageDeps> = {}): FlightStageDeps =>
    deps({
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => ledger(100)) as unknown as never,
        runEngine: (async () => { throw new Error('runEngine must not run for an external producer') }) as unknown as never,
      },
      ...over,
    })

  const mappingPark = (over: Record<string, unknown> = {}) => ({
    checkpoint: {
      kind: 'external-work' as const,
      message: 'x',
      data: {
        handOffId: 'live-id',
        context: { phase: 'mapping', pass: { iteration: 1, validationErrors: '', passes: [] }, roster: [TEST_NAME] },
        ...over,
      },
    },
  })

  it('a validated authoring submit parks AGAIN for the mapping half, roster pinned', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { phase: 'authoring', pass: { iteration: 1, validationErrors: '', passes: [] } } } } })
    const d = mapDeps({ coverage: { compute: (() => ledger(0)) as unknown as never, runEngine: (async () => ({})) as unknown as never } })
    const cp = handOffOf(await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote specs' }))
    expect(cp.kind).toBe('external-work')
    const context = cp.data.context as { phase: string; pass: { iteration: number }; roster: string[] }
    expect(context.phase).toBe('mapping')
    expect(context.pass.iteration).toBe(1)
    expect(context.roster).toEqual([TEST_NAME])
    // The annotate prompt, not the authoring one — the mapping is its own job.
    expect(String(cp.data.prompt)).not.toContain('Write the spec files')
  })

  it('a complete mapping answer writes the tags via the canonical writer and settles on the recompute', async () => {
    const dir = fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: { mappings: [{ testName: TEST_NAME, requirements: ['R1'] }] },
    })
    expect(out).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    // The tag landed on disk — the canonical writer ran, not an agent's claim.
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).toContain('@req-R1')
  })

  // The regression that made an external flight unable to clear this step at all.
  // `data` is schema'd `z.unknown()`, so an MCP client may JSON-ENCODE its answer;
  // the prd-summary hand-off two stages earlier decoded that, this one did not, and
  // the identical submission re-parked here forever until the step was handed back
  // with run-internally. Asserted through the SAME observable consequence as the
  // object case — the tag on disk — so it cannot pass by merely not erroring.
  it('accepts a JSON-ENCODED mapping submission, exactly as an object one', async () => {
    const dir = fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: JSON.stringify({ mappings: [{ testName: TEST_NAME, requirements: ['R1'] }] }),
    })
    expect(out).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).toContain('@req-R1')
  })

  it('re-parks a mapping submission that is a string but not JSON', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: 'I mapped them all, trust me',
    })
    const cp = (out as { checkpoint: { data: Record<string, unknown> } }).checkpoint
    expect(String(cp.data.lastRejection)).toContain('not parseable JSON')
  })

  it('an incomplete answer re-parks the SAME ask, naming the missing tests', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: { mappings: [], unmappable: [] },
    })
    const cp = handOffOf(out)
    expect(String(cp.data.lastRejection)).toContain(TEST_NAME)
    // Same ask: the pinned roster and hand-off id survive the rejection.
    expect(cp.data.handOffId).toBe('live-id')
    expect((cp.data.context as { roster: string[] }).roster).toEqual([TEST_NAME])
  })

  it('a test in unmappable[] satisfies the roster (silence is the only rejection)', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: { mappings: [], unmappable: [{ testName: TEST_NAME, reason: 'no requirement applies' }] },
    })
    expect(out).toMatchObject({ kind: 'done' })
  })

  it('a malformed mapping submission re-parks naming the first bad field', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: { mappings: [{ testName: 42 }] },
    })
    const cp = handOffOf(out)
    expect(String(cp.data.lastRejection)).toContain('mappings.0')
  })

  it('discards a mapping submit answering a superseded hand-off', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })
    expect(out).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('maps locally when the client hands the MAPPING back — one step, not the stage', async () => {
    fullFeature()
    const { ctx, setStage, logs } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark())
    let engineRuns = 0
    const d = mapDeps({
      coverage: {
        compute: (() => ledger(100)) as unknown as never,
        runEngine: (async () => { engineRuns += 1 }) as unknown as never,
      },
    })
    expect(await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({ kind: 'done' })
    expect(engineRuns).toBe(1)
    expect(logs.join('')).toContain('mapping back')
  })

  it('a park that lost its roster skips the completeness check (upgrade safety) and still recomputes', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', mappingPark({ context: { phase: 'mapping', pass: { iteration: 1, validationErrors: '', passes: [] } } }))
    const out = await specsCoverageStage(mapDeps()).onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: 'live-id',
      data: { mappings: [], unmappable: [] },
    })
    expect(out).toMatchObject({ kind: 'done' })
  })

  it('round-trips the pass number through the real emitter — a burned pass re-parks at pass 2, not pass 1', async () => {
    fullFeature()
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    const prompts: string[] = []
    const d = deps({
      // Every dry-run fails, so each authoring pass burns and the loop re-parks
      // the NEXT pass through the real emitter.
      validateSpecs: async () => ({ ok: false, errors: 'specs do not compile' }),
      spawnAgent: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } },
      coverage: { compute: (() => ledger(0)) as unknown as never, runEngine: (async () => ({})) as unknown as never },
    })
    const adapter = specsCoverageStage(d)
    const first = await adapter.run(ctx)
    const firstCp = handOffOf(first)
    setStage('specs-coverage', { checkpoint: (first as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint })
    const second = await adapter.onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote specs', token: String(firstCp.data.handOffId) })
    const cp2 = handOffOf(second)
    // The park the EMITTER produced carries pass 2 where the responder reads it.
    expect((cp2.data.context as { pass: { iteration: number } }).pass.iteration).toBe(2)
    setStage('specs-coverage', { checkpoint: (second as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint })
    await adapter.onCheckpointResponse!(ctx, { choice: 'run-internally' })
    // The taken-back pass authored as pass 2 — the number survived the round trip.
    expect(prompts[0]).toContain('iteration 2')
  })
})
