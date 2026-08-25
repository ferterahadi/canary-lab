// Feature listing and test-file integrity (dirty-spec approve / commit / diff).
// Split out of client.ts; see that barrel for the shared surface.

import type { Feature } from './types'
import { defaultOpts, request, type ClientOptions } from './internal'

export function listFeatures(opts?: ClientOptions): Promise<Feature[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<Feature[]>(`${baseUrl}/api/features`, { method: 'GET' }, fetchImpl)
}

// Test-file integrity: accept the current spec content (Canary-local) so the
// dirty cue clears without a commit.
export function approveDirtySpecs(feature: string, opts?: ClientOptions): Promise<{ status: 'clean' | 'dirty' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/approve-dirty`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Test-file integrity: commit the modified specs to git (durable acknowledgment);
// HEAD then matches the working tree so the cue clears.
export function commitDirtySpecs(
  feature: string,
  opts?: ClientOptions,
): Promise<{ committed: boolean; status?: 'clean' | 'dirty'; reason?: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/commit-dirty`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Per-test changed line numbers (1-indexed, body-relative) for a dirty spec,
// diffed against git HEAD server-side — highlights exactly what changed in a
// dirty test's code view.
export function getFeatureDirtyDiff(
  feature: string,
  file: string,
  opts?: ClientOptions,
): Promise<{ tests: { name: string; changedLines: number[] }[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/dirty-diff?file=${encodeURIComponent(file)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

// ─── Requirement Coverage Ledger ─────────────────────────────────────────────
