import path from 'path'

// Per-benchmark directory layout under `<logs>/benchmarks/`. The two arms run
// as real runs under `<logs>/runs/<runId>/` (referenced by runId in the
// manifest); this dir only holds the benchmark-level artifacts.

export interface BenchmarkPaths {
  dir: string
  manifestPath: string
  /** The frozen sabotage diff — replayable/auditable. */
  sabotageDiffPath: string
  /** The sabotage skill recipe that was applied. */
  sabotageRecipePath: string
  reportPath: string
}

export function benchmarksRoot(logsDir: string): string {
  return path.join(logsDir, 'benchmarks')
}

export function benchmarksIndexPath(logsDir: string): string {
  return path.join(benchmarksRoot(logsDir), 'index.json')
}

export function benchmarkDir(logsDir: string, benchmarkId: string): string {
  return path.join(benchmarksRoot(logsDir), benchmarkId)
}

export function buildBenchmarkPaths(dir: string): BenchmarkPaths {
  return {
    dir,
    manifestPath: path.join(dir, 'benchmark.json'),
    sabotageDiffPath: path.join(dir, 'sabotage.diff'),
    sabotageRecipePath: path.join(dir, 'sabotage.md'),
    reportPath: path.join(dir, 'report.json'),
  }
}
