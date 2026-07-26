// Benchmark arms: sabotage skills, preflight, start/abort, worktrees.
// Split out of client.ts; see that barrel for the shared surface.

import {
  type BenchmarkIndexEntry,
  type BenchmarkManifest,
  type SabotageLevel,
  type SabotageSkillSummary,
} from '@/features/benchmark'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'
import type { AgentSessionResponse } from './agent-sessions'

export function listBenchmarks(opts?: ClientOptions): Promise<BenchmarkIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<BenchmarkIndexEntry[]>(`${baseUrl}/api/benchmarks`, { method: 'GET' }, fetchImpl)
}

export function getBenchmark(id: string, opts?: ClientOptions): Promise<BenchmarkManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<BenchmarkManifest>(
    `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listSabotageSkills(feature: string, opts?: ClientOptions): Promise<SabotageSkillSummary[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<SabotageSkillSummary[]>(
    `${baseUrl}/api/benchmark-skills?feature=${encodeURIComponent(feature)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export interface BenchmarkPreflight {
  portsConfigured: boolean
  repos: { name: string; commands: { name: string; declaredPorts: { name: string; env?: string }[] }[] }[]
}

// Does the feature declare injectable port slots? Benchmark arms boot the same
// feature concurrently, so an app with hardcoded ports would clash. When
// `portsConfigured` is false the UI offers the port-ification workflow.
export function benchmarkPreflight(
  feature: string,
  env?: string,
  opts?: ClientOptions,
): Promise<BenchmarkPreflight> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const q = new URLSearchParams({ feature })
  if (env) q.set('env', env)
  return request<BenchmarkPreflight>(
    `${baseUrl}/api/benchmarks/preflight?${q.toString()}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function startBenchmark(
  input: { feature: string; skill: string; level: SabotageLevel; iterations: number; agent?: 'claude' | 'codex' },
  opts?: ClientOptions,
): Promise<{ benchmarkId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ benchmarkId: string }>(
    `${baseUrl}/api/benchmarks`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    fetchImpl,
  )
}

export function abortBenchmark(id: string, opts?: ClientOptions): Promise<{ ok: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ ok: boolean }>(
    `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}/abort`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Open one of a benchmark's worktrees in the user's editor. `target`:
//   'frozen' → pristine checkout at the sabotage SHA (lazily created)
//   'A' / 'B' → the live arm worktree (only while the benchmark runs)
// Returns the resolved path even when the editor couldn't launch (opened:false)
// so the UI can offer a copy-path fallback.
export function openBenchmarkWorktree(
  id: string,
  target: 'frozen' | 'A' | 'B',
  opts?: ClientOptions,
): Promise<{ opened: boolean; path: string; editor?: string; error?: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}/open-worktree`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) },
    fetchImpl,
  )
}

// Clear a finished benchmark's worktrees. Two-phase, mirroring the route: call
// with `confirm: false` (default) for a dry run that returns the disk it would
// free (shown in the confirm dialog), then `confirm: true` to actually remove
// them. `cleared`/`freedBytes` reflect what was removed.
export function clearBenchmarkWorktrees(
  id: string,
  confirm: boolean,
  opts?: ClientOptions,
): Promise<{ confirmed: boolean; willClear: number; cleared: number; freedBytes: number; alreadyCleared?: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}/clear-worktrees`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) },
    fetchImpl,
  )
}


export async function getBenchmarkAgentSession(
  id: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

// ─── Port-ification ──────────────────────────────────────────────────────
