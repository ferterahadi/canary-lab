import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scoutStage } from './scout'
import { docsStage } from './docs'
import { specsCoverageStage } from './specs-coverage'
import type { FlightStageDeps } from './context'
import type { StageContext, StageOutcome } from '../conductor'
import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

// The hand-off path: `opts.stageProducer === 'external'` makes scout, docs and
// specs↔coverage park on an `external-work` checkpoint instead of spawning a local
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
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', 'fl-ext'),
      signal: new AbortController().signal,
      appendLog: (c) => { logs.push(c) },
      setProgress: () => {},
      patchFlight: () => {},
    },
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

  it('settles from the doc the CLIENT wrote — not from what it claims', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, '# Requirements\n- must check out\n')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } })
    const settled = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote it' })
    expect(settled).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs' } })
  })

  it('re-parks when the client claims success but wrote no file', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } })
    const cp = handOffOf(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', data: 'all done!' }))
    // Straight back to the human fork, carrying the empty-handed verdict.
    expect(cp.kind).toBe('prd-source')
    expect((cp.data.lastAttempt as { outcome: string }).outcome).toBe('no-output')
  })

  it('mines a NOTHING_FOUND reason out of the client reply', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'x.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'infer-from-diff', outPath, outName: 'x.md' } } })
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
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } })
    expect(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', ...(data === undefined ? {} : { data }) })).toMatchObject({
      kind: 'done',
      evidence: { source: 'agent-repo-docs' },
    })
  })

  it('fails when the hand-off lost its output path', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'collect-repo-docs' } } })
    expect(await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({
      kind: 'failed',
      error: 'external docs hand-off lost its output path',
    })
  })

  it('collects locally when the client hands the step back', async () => {
    const { ctx, setStage, logs } = ctxFor(docsManifest())
    const outPath = path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md')
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: { mode: 'collect-repo-docs', outPath, outName: 'checkout-prd.md' } } })
    const d = deps({
      spawnAgent: async () => { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, '# reqs\n'); return { text: 'done' } },
    })
    expect(await docsStage(d).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({ kind: 'done' })
    expect(logs.join('')).toContain('handed the step back')
  })

  it('defaults a hand-off with no recorded mode to the repo-docs collector', async () => {
    const { ctx, setStage } = ctxFor(docsManifest())
    setStage('docs', { checkpoint: { kind: 'external-work', message: 'x', data: {} } })
    const out = await docsStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })
    expect(out).toMatchObject({ kind: 'failed' })
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

  it('settles on the recomputed ledger when the client\'s specs close the gap', async () => {
    const { ctx, setStage } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { pass: { iteration: 1, validationErrors: '', passes: [] } } } })
    // Fresh compute on resume sees 100% — the CLIENT's files raised it, and the
    // ledger (not the client's word) is what settles the stage.
    const d = specsDeps({ coverage: { compute: (() => ledger(100)) as unknown as never, runEngine: (async () => ({})) as unknown as never } })
    const out = await specsCoverageStage(d).onCheckpointResponse!(ctx, { choice: 'submit', data: 'wrote 3 specs' })
    expect(out).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
  })

  it('hands the pass back to the local agent on run-internally, keeping the pass number', async () => {
    const { ctx, setStage, logs } = ctxFor(manifest({ currentStage: 'specs-coverage' }))
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { pass: { iteration: 2, validationErrors: '', passes: [] } } } })
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
    setStage('specs-coverage', { checkpoint: { kind: 'external-work', message: 'x', data: { pass: { iteration: 1, validationErrors: '', passes: [] } } } })
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
