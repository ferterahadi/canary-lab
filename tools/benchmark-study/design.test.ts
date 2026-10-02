import { expect, it } from 'vitest'
import { blockIntervals, pairedInterval, validateDesign } from './design'
import { schedule } from './scenarios'
import { summarize } from './report'
import { totalTokens } from './usage'
import type { StudyDesign, StudyManifest } from './types'
import { summarizeVariants } from './variant-report'
import { configurationDigest, assertExperiment, policyDigests } from './experiment'

const screening: StudyDesign = { mode: 'live', repetitions: 5, seed: 29, variants: [
  { id: 'control', diagnosisPolicy: 'per-failure' }, { id: 'parent', diagnosisPolicy: 'parent-only' }, { id: 'adaptive', diagnosisPolicy: 'adaptive' },
] }

it('keeps all three variant arms adjacent, balances every position and preserves legacy schedules', () => {
  const attempts = schedule({ agent: 'codex' }, screening)
  expect(attempts).toHaveLength(30)
  expect(new Set(attempts.map((a) => a.id)).size).toBe(30)
  expect(attempts).toEqual(schedule({ agent: 'codex' }, screening))
  for (let i = 0; i < attempts.length; i += 3) {
    expect(new Set(attempts.slice(i, i + 3).map((a) => `${a.agent}/${a.scenario}/${a.repetition}`)).size).toBe(1)
    expect(new Set(attempts.slice(i, i + 3).map((a) => a.variant!.id)).size).toBe(3)
  }
  for (const scenario of ['single-service', 'cross-service']) for (const arm of screening.variants!) {
    const counts = [0, 1, 2].map((position) => attempts.filter((a, i) => i % 3 === position && a.scenario === scenario && a.variant!.id === arm.id).length)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  }
  expect(schedule()).toHaveLength(16)
  expect(() => validateDesign({ ...screening, variants: [screening.variants![1], screening.variants![1]] })).toThrow()
  expect(() => validateDesign({ ...screening, mode: 'replay' })).toThrow()
})

it('resamples whole multi-arm blocks, excludes incomplete comparisons and retains failed-arm totals', () => {
  const blocks = Array.from({ length: 5 }, (_, i) => ({ control: 100 + i, parent: 80 + i, adaptive: 70 + i }))
  const stats = blockIntervals(blocks, 'control', ['control', 'parent', 'adaptive'], 42)
  expect(stats.every((stat) => stat.blocks === 5 && stat.bootstrap95 !== null)).toBe(true)
  expect(stats).toEqual(blockIntervals(blocks, 'control', ['control', 'parent', 'adaptive'], 42))
  expect(blockIntervals([...blocks, { control: 1, parent: 1 }], 'control', ['control', 'parent', 'adaptive'], 42)).toEqual(stats)
  const attempts = schedule({ agent: 'codex' }, screening)
  const manifest = { attempts, design: screening, results: attempts.slice(0, 3).map((a, i) => ({ ...a, outcome: i ? 'success' : 'failed', repairMs: 100, usage: { input: 50, output: 10 } })) } as StudyManifest
  const summary = summarizeVariants(manifest).find((g) => g.scenario === attempts[0].scenario)!
  expect(summary.successfulBlocks).toBe(0)
  expect(summary.arms.reduce((n, a) => n + a.recorded, 0)).toBe(3)
  expect(summary.arms.reduce((n, a) => n + a.tokens!, 0)).toBe(180)
  expect(summarize(manifest)).toEqual([])
})

it('freezes settings and prompt digests without including mutable results', () => {
  const manifest = { design: screening, attempts: schedule({ agent: 'codex' }, screening), results: [], pins: {}, experiment: { maxTokens: 1000, configurationDigest: '', promptDigests: policyDigests({ design: screening }) } } as unknown as StudyManifest
  manifest.experiment!.configurationDigest = configurationDigest(manifest)
  expect(() => assertExperiment(manifest, true)).not.toThrow()
  expect(() => assertExperiment({ ...manifest, status: 'running' }, true)).not.toThrow()
  expect(() => assertExperiment({ ...manifest, budgetMs: 1 })).toThrow('configuration')
  expect(Object.values(manifest.experiment!.promptDigests)).toHaveLength(3)
  expect(new Set(Object.values(manifest.experiment!.promptDigests)).size).toBe(3)
})

it('randomizes complete adjacent pairs reproducibly and balances order within every stratum', () => {
  const design: StudyDesign = { mode: 'live', repetitions: 10, seed: 42 }
  const attempts = schedule(undefined, design)
  expect(attempts).toHaveLength(80)
  expect(new Set(attempts.map((a) => a.id)).size).toBe(80)
  expect(attempts).toEqual(schedule(undefined, design))
  expect(attempts).not.toEqual(schedule(undefined, { ...design, seed: 43 }))
  for (let i = 0; i < attempts.length; i += 2) {
    const a = attempts[i]; const b = attempts[i + 1]
    expect([a.agent, a.scenario, a.repetition]).toEqual([b.agent, b.scenario, b.repetition])
    expect(a.workflow).not.toBe(b.workflow)
  }
  for (const agent of ['codex', 'claude']) for (const scenario of ['single-service', 'cross-service']) {
    expect(attempts.filter((a, i) => i % 2 === 0 && a.agent === agent && a.scenario === scenario && a.workflow === 'canary')).toHaveLength(5)
  }
  expect(schedule(undefined, { ...design, mode: 'replay' })).toHaveLength(40)
  expect(schedule({ agent: 'claude', scenario: 'cross-service' }, design)).toHaveLength(20)
  expect(() => validateDesign({ ...design, repetitions: 1 })).toThrow()
  expect(() => validateDesign({ ...design, repetitions: 2.5 })).toThrow()
  expect(() => validateDesign({ ...design, seed: -1 })).toThrow()
  expect(() => validateDesign({ ...design, mode: 'bad' } as never)).toThrow()
})

it('reports deterministic paired uncertainty without intervals for tiny samples or inferred successes', () => {
  const pairs = [{ canaryMs: 50, plainMs: 100 }, { canaryMs: 90, plainMs: 100 }, { canaryMs: 70, plainMs: 100 },
    { canaryMs: 110, plainMs: 100 }, { canaryMs: 80, plainMs: 100 }]
  const stats = pairedInterval(pairs, 42)!
  expect(stats.reductionPercent).toBeCloseTo(20)
  expect(stats.bootstrap95![0]).toBeLessThan(20)
  expect(stats.bootstrap95![1]).toBeGreaterThan(20)
  expect(stats).toEqual(pairedInterval(pairs, 42))
  expect(pairedInterval(pairs.slice(0, 2), 42)!.bootstrap95).toBeNull()
  expect(pairedInterval([], 42)).toBeNull()
  const attempts = schedule({ agent: 'codex', scenario: 'cross-service' }, { mode: 'live', repetitions: 10, seed: 42 })
  const manifest = { attempts, results: attempts.slice(0, 2).map((a) => ({ ...a, outcome: a.workflow === 'plain' ? 'success' : 'timeout', repairMs: 100, usage: null })) } as StudyManifest
  expect(summarize(manifest)[0].pairs).toHaveLength(10)
  expect(summarize(manifest)[0].interval).toBeNull()
  expect(summarize({ ...manifest, results: [] })[0].workflows[0].totalRepairMs).toBeNull()
})

it('includes Claude cache traffic without double-counting Codex cache and preserves unknown usage', () => {
  const usage = { input: 100, output: 10, cacheRead: 80, cacheWrite: 20 }
  expect(totalTokens('codex', usage)).toBe(110)
  expect(totalTokens('claude', usage)).toBe(210)
  expect(totalTokens('claude', { ...usage, cacheRead: null })).toBeNull()
  expect(totalTokens('codex', null)).toBeNull()
})
