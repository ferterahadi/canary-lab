// Disk reclamation: run logs, worktrees, portify records, run artifacts.
// Split out of client.ts; see that barrel for the shared surface.

import type { CleanupListing, CleanupWorktree, PortifyCleanupListing } from './types'
import { defaultOpts, request, type ClientOptions } from './internal'

// Disk-usage listing for the Log Cleanup page: every run + orphan dir with
// folder/artifact byte sizes and reclaimable totals.
export function cleanupRuns(opts?: ClientOptions): Promise<CleanupListing> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CleanupListing>(`${baseUrl}/api/cleanup/runs`, { method: 'GET' }, fetchImpl)
}

// Every git worktree canary-lab created under the logs dir (inspect snapshots,
// per-run isolation, benchmark arms, stale orphans), for the cleanup list.
export function cleanupWorktrees(opts?: ClientOptions): Promise<{ worktrees: CleanupWorktree[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/cleanup/worktrees`, { method: 'GET' }, fetchImpl)
}

// Every port-ification workflow record with its folder size, for the Log
// Cleanup "Portify" tab. Pruning a record reuses removePortify(workflowId).
export function cleanupPortify(opts?: ClientOptions): Promise<PortifyCleanupListing> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyCleanupListing>(`${baseUrl}/api/cleanup/portify`, { method: 'GET' }, fetchImpl)
}

// Open the port-ification project in the user's editor — the scratch worktree
// while the workflow is live, else the saved overlay folder
// (features/<feature>/portify/) once the worktrees are discarded.
export function openPortifyProject(
  workflowId: string,
  opts?: ClientOptions,
): Promise<{ opened: boolean; paths: string[]; editor?: string; error?: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/open`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Open a worktree folder in the user's editor ("visit" from the cleanup list).
export function openWorktreePath(
  path: string,
  opts?: ClientOptions,
): Promise<{ opened: boolean; path: string; editor?: string; error?: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/cleanup/worktrees/open`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) },
    fetchImpl,
  )
}

// Remove one worktree via `git worktree remove` (+ prune). Server returns 409
// when the worktree belongs to a still-active run/benchmark.
export function removeWorktree(path: string, opts?: ClientOptions): Promise<{ removed: boolean; freedBytes: number }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/cleanup/worktrees`,
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) },
    fetchImpl,
  )
}

// Reclaim a terminal run's Playwright artifacts (videos/traces) while keeping
// the run in history. Server returns 409 if the run is still active.
export async function trimRun(runId: string, opts?: ClientOptions): Promise<{ freedBytes: number }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ freedBytes: number }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/trim`,
    { method: 'POST' },
    fetchImpl,
  )
}
