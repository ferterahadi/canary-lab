import type { StudyDesign } from './types'

export function validateDesign(design: StudyDesign): void {
  if (!['live', 'replay'].includes(design.mode) || !Number.isInteger(design.repetitions) || design.repetitions < 2 || design.repetitions > 100 ||
      !Number.isInteger(design.seed) || design.seed < 0 || design.seed > 0xffffffff) {
    throw new Error('Design requires live/replay mode, 2–100 repetitions, and a uint32 seed')
  }
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
