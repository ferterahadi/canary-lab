import path from 'path'

// Per-job directory layout under `<logs>/coverage-jobs/`. Mirrors portify/paths.

export interface CoverageJobPaths {
  dir: string
  manifestPath: string
}

/** The `<logs>/` subdirectory name — shared with the store's record layout. */
export const COVERAGE_JOBS_DIR_NAME = 'coverage-jobs'

export function coverageJobsRoot(logsDir: string): string {
  return path.join(logsDir, COVERAGE_JOBS_DIR_NAME)
}

export function coverageJobsIndexPath(logsDir: string): string {
  return path.join(coverageJobsRoot(logsDir), 'index.json')
}

export function coverageJobDir(logsDir: string, jobId: string): string {
  return path.join(coverageJobsRoot(logsDir), jobId)
}

export function buildCoverageJobPaths(dir: string): CoverageJobPaths {
  return {
    dir,
    manifestPath: path.join(dir, 'job.json'),
  }
}
