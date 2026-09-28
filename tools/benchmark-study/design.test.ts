import { expect, it } from 'vitest'
import { pairedInterval, validateDesign } from './design'
import { schedule } from './scenarios'
import { totalTokens, summarize } from './report'
import type { StudyDesign, StudyManifest } from './types'

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
