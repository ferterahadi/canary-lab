import { describe, it, expect } from 'vitest'
import {
  benchmarksRoot,
  benchmarksIndexPath,
  benchmarkDir,
  buildBenchmarkPaths,
} from './paths'

describe('benchmark paths', () => {
  it('derives the benchmarks root + index under a logs dir', () => {
    expect(benchmarksRoot('/logs')).toBe('/logs/benchmarks')
    expect(benchmarksIndexPath('/logs')).toBe('/logs/benchmarks/index.json')
  })

  it('derives a per-benchmark directory', () => {
    expect(benchmarkDir('/logs', 'b1')).toBe('/logs/benchmarks/b1')
  })

  it('builds the per-benchmark file layout from a benchmark dir', () => {
    const p = buildBenchmarkPaths('/logs/benchmarks/b1')
    expect(p.dir).toBe('/logs/benchmarks/b1')
    expect(p.manifestPath).toBe('/logs/benchmarks/b1/benchmark.json')
    expect(p.sabotageDiffPath).toBe('/logs/benchmarks/b1/sabotage.diff')
    expect(p.sabotageRecipePath).toBe('/logs/benchmarks/b1/sabotage.md')
    expect(p.reportPath).toBe('/logs/benchmarks/b1/report.json')
  })
})
