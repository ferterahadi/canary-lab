import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import { execFileSync } from 'child_process'

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

import { attemptLogLine, describeAttempt, docsStage } from './docs'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'

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

describe('docs stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
  })

  function initGitRepoWithDiff(): void {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\nworld\n'.repeat(5))
    run(['add', '.'])
    run(['commit', '-qm', 'change'])
  }

  it('checkpoint response: retry re-runs and re-parks when nothing changed', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'retry' })
    expect(outcome.kind).toBe('checkpoint')
  })

  it('checkpoint response: infer-from-diff spawns the collector agent, which writes the feature-named doc', async () => {
    initGitRepoWithDiff()
    const prompts: string[] = []
    const spawnAgent: FlightStageDeps['spawnAgent'] = async (opts) => {
      prompts.push(opts.prompt)
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-from-diff.md'), '# Derived requirements\n- adds world lines')
      return { text: 'derived requirements from the diff' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'infer-from-diff', feedback: 'skip the refactor noise' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-diff', docs: ['checkout-from-diff.md'] } })
    // The prompt carries the intent, the output path, and the feedback note.
    expect(prompts[0]).toContain('checkout flow')
    expect(prompts[0]).toContain('checkout-from-diff.md')
    expect(prompts[0]).toContain('skip the refactor noise')
  })

  it('checkpoint response: infer-from-diff with no meaningful diff re-parks without spawning', async () => {
    // No git repo at all — detectBaseBranch finds nothing to diff.
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => {
      throw new Error('must not spawn')
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'infer-from-diff' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('No meaningful diff')
  })

  it('checkpoint response: collect-repo-docs settles done when the agent writes the doc', async () => {
    let cwd = ''
    const spawnAgent: FlightStageDeps['spawnAgent'] = async (opts) => {
      cwd = opts.cwd
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md'), '# Requirements\n- does the thing')
      return { text: 'collected from README' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs', docs: ['checkout-prd.md'] } })
    expect(cwd).toBe(tmpDir)
  })

  it('checkpoint response: an empty-handed collector re-parks with the NOTHING_FOUND reason', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: repos carry no requirement material' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('repos carry no requirement material')
  })

  it('checkpoint response: an empty-handed collector re-parks with a STRUCTURED attempt', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: no loyalty flow in either repo' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    // The UI keys its verdict band + recommendation flip off this, not off the
    // prose in `message`.
    expect(outcome.checkpoint.data).toMatchObject({
      lastAttempt: { mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo' },
    })
  })

  it('checkpoint response: a reason ending in a period is not double-punctuated', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: the flow does not exist in either repo.' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('does not exist in either repo.')
    expect(outcome.checkpoint.message).not.toContain('repo..')
  })

  it('a rejected attempt logs a TERMINAL line — named attempt, verdict, and the way out', async () => {
    // The activity band is append-only: a rejected attempt sits above whatever
    // ran next. Without "came back empty" + "back to your choice" the line
    // reads as a live failure long after the user has moved on.
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: no loyalty flow in either repo' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const log: string[] = []
    ctx.appendLog = (chunk) => { log.push(chunk) }
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })

    const text = log.join('')
    expect(text).toContain('[docs] agent attempt (collect repo docs) — reading the repos guided by the intent…')
    expect(text).toContain('[docs] agent attempt (collect repo docs) came back empty — no loyalty flow in either repo.')
    expect(text).toContain('Back to your choice: add docs yourself, or retry with feedback.')
    // The spawn line must keep its ellipsis — StageActivity splits the band on it.
    expect(log.some((l) => l.trimEnd().endsWith('…'))).toBe(true)
  })

  it('a succeeding attempt says so, so the band reads as a sequence of verdicts', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async (o) => {
      fs.writeFileSync(o.prompt.match(/\/[^\s]*checkout-prd\.md/)![0], '# collected\n')
      return { text: 'done' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const log: string[] = []
    ctx.appendLog = (chunk) => { log.push(chunk) }
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    expect(log.join('')).toContain('agent attempt (collect repo docs) succeeded — wrote docs/checkout-prd.md')
  })

  it('qualifies the from-diff doc with the repo name when the flight spans several repos', async () => {
    // Single-repo flights get a clean `<feature>-from-diff.md`; multi-repo needs
    // the repo qualifier or the second repo would overwrite the first.
    initGitRepoWithDiff()
    const secondRepo = path.join(tmpDir, 'second-repo')
    fs.mkdirSync(secondRepo, { recursive: true })
    // `secondRepo` is not a git repo at all, and the explicit base pushes it
    // past the base-detection guard — so the git probe itself has to fail soft
    // rather than take the whole stage down.
    const m = manifest({
      repoPaths: [repoDir, secondRepo],
      opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' },
    })

    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)

    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs).toContain(`checkout-from-diff-${path.basename(repoDir)}.md`.toLowerCase())
    // Nothing was written for the non-git repo.
    expect(docs.filter((f) => f.startsWith('checkout-from-diff'))).toHaveLength(1)
  })

  it('checkpoint response: a collector that writes nothing and says nothing reports no-output', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'I had a look around.' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.data).toMatchObject({ lastAttempt: { outcome: 'no-output' } })
  })

  it('a first visit carries no lastAttempt — the agent path stays the recommendation', async () => {
    const adapter = docsStage(deps())
    const { ctx } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { lastAttempt?: unknown }).lastAttempt).toBeUndefined()
  })

  it('checkpoint response: description-only settles immediately', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'description-only' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('checkpoint response: an unrecognized choice re-runs from scratch', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome.kind).toBe('checkpoint')
  })
})

describe('docs attempt prose', () => {
  // Both forms are pinned directly: `reason` is optional on the persisted
  // shape, so a record written by an older build can reach the fallbacks that
  // today's collector never produces.
  it('describeAttempt names each outcome, and emits the reason unpunctuated-by-us', () => {
    expect(describeAttempt({ mode: 'infer-from-diff', outcome: 'no-diff' }))
      .toBe('No meaningful diff vs the base branch was found.')
    expect(describeAttempt({ mode: 'collect-repo-docs', outcome: 'no-output' }))
      .toBe('The agent did not produce a requirements doc.')
    expect(describeAttempt({ mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo' }))
      .toBe('The agent found nothing relevant: no loyalty flow in either repo.')
    // Already terminated — must not gain a second period ("…repo..").
    expect(describeAttempt({ mode: 'collect-repo-docs', outcome: 'empty', reason: 'it does not exist here!' }))
      .toBe('The agent found nothing relevant: it does not exist here!')
  })

  it('describeAttempt stands on its own when an empty attempt carries no reason', () => {
    for (const attempt of [
      { mode: 'collect-repo-docs', outcome: 'empty' } as const,
      { mode: 'collect-repo-docs', outcome: 'empty', reason: '   ' } as const,
    ]) {
      expect(describeAttempt(attempt)).toBe('The agent searched and found nothing relevant.')
    }
  })

  it('attemptLogLine names the attempt, the verdict, and the two ways out', () => {
    expect(attemptLogLine({ mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo.' }))
      .toBe('[docs] agent attempt (collect repo docs) came back empty — no loyalty flow in either repo. Back to your choice: add docs yourself, or retry with feedback.\n')
    expect(attemptLogLine({ mode: 'infer-from-diff', outcome: 'no-diff' }))
      .toContain('(infer from diff) came back empty — no meaningful diff vs the base branch in any repo.')
    expect(attemptLogLine({ mode: 'collect-repo-docs', outcome: 'no-output' }))
      .toContain('came back empty — the agent produced no requirements doc.')
  })

  it('attemptLogLine falls back to its own wording for a reasonless empty attempt', () => {
    expect(attemptLogLine({ mode: 'collect-repo-docs', outcome: 'empty' }))
      .toContain('came back empty — the agent searched and found nothing relevant.')
  })
})
