import type { StudyDesign } from './types'
import { diagnosisPolicy } from '../../shared/diagnosis-policy'

export function validateDesign(design: StudyDesign): void {
  if (!['live', 'replay'].includes(design.mode) || !Number.isInteger(design.repetitions) || design.repetitions < 2 || design.repetitions > 100 ||
      !Number.isInteger(design.seed) || design.seed < 0 || design.seed > 0xffffffff) {
    throw new Error('Design requires live/replay mode, 2–100 repetitions, and a uint32 seed')
  }
  if (design.variants) {
    if (design.mode !== 'live' || design.variants.length < 2 || design.variants.length > 3 ||
      new Set(design.variants.map((v) => v.id)).size !== design.variants.length ||
      new Set(design.variants.map((v) => v.diagnosisPolicy)).size !== design.variants.length ||
      !design.variants.some((v) => v.diagnosisPolicy === 'per-failure')) throw new Error('Diagnosis screening requires 2–3 distinct live variants including per-failure control')
    for (const variant of design.variants) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(variant.id)) throw new Error('Invalid variant ID')
      diagnosisPolicy(variant.diagnosisPolicy)
    }
  }
}

// Randomize labels and block order while rotating positions: every arm appears
// in every position equally often (within one when repetitions are indivisible).
export function balancedOrders<T>(arms: T[], repetitions: number, next: () => number): T[][] {
  const orders: T[][] = []
  while (orders.length < repetitions) {
    const labels = shuffle(arms, next)
    const rotations = shuffle(labels.map((_, i) => labels.map((_, j) => labels[(i + j) % labels.length])), next)
    orders.push(...rotations.slice(0, repetitions - orders.length))
  }
  return shuffle(orders, next)
}

export function blockIntervals(blocks: Array<Record<string, number>>, control: string, arms: string[], seed: number) {
  const complete = blocks.filter((block) => arms.every((arm) => Number.isFinite(block[arm]) && block[arm] >= 0) && block[control] > 0)
  const reduction = (rows: typeof blocks, arm: string): number => 100 * (1 - rows.reduce((n, b) => n + b[arm], 0) / rows.reduce((n, b) => n + b[control], 0))
  const next = random(seed)
  const samples = complete.length < 5 ? [] : Array.from({ length: 5000 }, () => complete.map(() => complete[Math.floor(next() * complete.length)]))
  return arms.filter((arm) => arm !== control).map((arm) => {
    const values = samples.map((sample) => reduction(sample, arm)).sort((a, b) => a - b)
    return { arm, control, blocks: complete.length, reductionPercent: complete.length ? reduction(complete, arm) : null,
      bootstrap95: values.length ? [values[125], values[4874]] : null }
  })
}

export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let n = Math.imul(seed ^ seed >>> 15, 1 | seed)
    n ^= n + Math.imul(n ^ n >>> 7, 61 | n)
    return ((n ^ n >>> 14) >>> 0) / 4294967296
  }
}

export function shuffle<T>(values: T[], next: () => number): T[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// Resample whole pairs, never independent arms: each pair shares a scenario
// and nearby execution time. The interval describes successful pairs only.
export function pairedInterval(pairs: Array<{ canaryMs: number; plainMs: number }>, seed: number) {
  if (!pairs.length) return null
  const reduction = (rows: typeof pairs): number => 100 * (1 - rows.reduce((n, r) => n + r.canaryMs, 0) / rows.reduce((n, r) => n + r.plainMs, 0))
  const estimate = reduction(pairs)
  if (pairs.length < 5) return { pairs: pairs.length, reductionPercent: estimate, bootstrap95: null }
  const next = random(seed)
  const samples = Array.from({ length: 5000 }, () => reduction(pairs.map(() => pairs[Math.floor(next() * pairs.length)]))).sort((a, b) => a - b)
  return { pairs: pairs.length, reductionPercent: estimate, bootstrap95: [samples[125], samples[4874]] }
}
