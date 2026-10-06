import type { OnboardingSamples } from '@shared/getting-started'
// Feature + project configuration: config docs, Playwright, envsets, ports.
// Split out of client.ts; see that barrel for the shared surface.

import type { FeatureTests } from './types'
import type { ProjectConfigResponse } from '@shared/project-config'
import type { AgentProbeSnapshotResponse } from '@shared/agent-probe'
import { requestJson, ApiError, defaultOpts, request, type ClientOptions } from './internal'

export function getFeatureTests(name: string, opts?: ClientOptions, runId?: string): Promise<FeatureTests> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FeatureTests>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/tests${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export interface FeatureConfigDoc {
  path: string
  content: string
  format: 'cjs' | 'js' | 'ts'
}

export function getFeatureConfig(name: string, opts?: ClientOptions): Promise<FeatureConfigDoc> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FeatureConfigDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/config`,
    { method: 'GET' },
    fetchImpl,
  )
}

// ─── structured config editing ────────────────────────────────────────────

/** A `$expr`-tagged object stands in for a non-literal expression
 *  (e.g. `__dirname`, `process.env.CI ? 2 : 1`). The UI treats these as
 *  read-only; the server round-trips them through the AST unchanged. */
export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | { $expr: string }
  | ConfigValue[]
  | { [k: string]: ConfigValue }

export interface ParsedConfigDoc {
  path: string
  format: 'cjs' | 'js' | 'ts'
  content: string
  parsed: { value: ConfigValue; complexFields: string[]; source: string }
}

export function getFeatureConfigDoc(name: string, opts?: ClientOptions): Promise<ParsedConfigDoc> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ParsedConfigDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/config-doc`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function putFeatureConfigDoc(
  name: string,
  value: ConfigValue,
  opts?: ClientOptions,
): Promise<ParsedConfigDoc> {
  return requestJson<ParsedConfigDoc>(`/api/features/${encodeURIComponent(name)}/config-doc`, 'PUT', { value }, opts)
}

/** Fully un-portify a feature: restore the pre-Portify feature config (slots +
 *  ${port.x} rewrites) from the overlay's snapshot, then delete the overlay.
 *  `reverted` is false for legacy overlays with no snapshot (overlay-only
 *  removal). Fires features-changed so the Portified badge flips live. */
export function removePortifyOverlay(
  name: string,
  opts?: ClientOptions,
): Promise<{ name: string; portified: boolean; reverted: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ name: string; portified: boolean; reverted: boolean }>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/portify-overlay`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function deleteFeature(
  name: string,
  confirmName: string,
  opts?: ClientOptions,
): Promise<void> {
  await requestJson<unknown>(`/api/features/${encodeURIComponent(name)}`, 'DELETE', { confirmName }, opts)
}

export function getPlaywrightConfig(name: string, opts?: ClientOptions): Promise<ParsedConfigDoc> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ParsedConfigDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/playwright`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function putPlaywrightConfig(
  name: string,
  value: ConfigValue,
  opts?: ClientOptions,
): Promise<ParsedConfigDoc> {
  return requestJson<ParsedConfigDoc>(`/api/features/${encodeURIComponent(name)}/playwright`, 'PUT', { value }, opts)
}

export interface McpHealth {
  ok: boolean
  server: { name: string; version?: string }
  profile: string
  clientKind: string
  toolCount: number
  tools?: string[]
  activeSessions: number
  projectRoot: string
}

export function getMcpHealth(opts?: ClientOptions): Promise<McpHealth> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<McpHealth>(
    `${baseUrl}/mcp/health?profile=compact`,
    { method: 'GET' },
    fetchImpl,
  )
}

// ─── envsets ──────────────────────────────────────────────────────────────

export interface EnvsetIndex {
  envs: { name: string; slots: string[] }[]
  slotDescriptions: Record<string, string>
  slotTargets?: Record<string, string>
  slotTargetsRaw?: Record<string, string>
}

export interface EnvsetSlotDoc {
  path: string
  content: string
  entries: { key: string; value: string }[]
  unparsedLines: number[]
}

export function getEnvsetsIndex(name: string, opts?: ClientOptions): Promise<EnvsetIndex> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EnvsetIndex>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getEnvsetSlot(
  name: string,
  env: string,
  slot: string,
  opts?: ClientOptions,
): Promise<EnvsetSlotDoc> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EnvsetSlotDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets/${encodeURIComponent(env)}/${encodeURIComponent(slot)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function createEnvset(
  name: string,
  env: string,
  opts?: ClientOptions,
): Promise<{ env: string }> {
  return requestJson<{ env: string }>(`/api/features/${encodeURIComponent(name)}/envsets`, 'POST', { env }, opts)
}

export async function deleteEnvset(
  name: string,
  env: string,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets/${encodeURIComponent(env)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export function addEnvsetSlot(
  name: string,
  body: { sourcePath: string; slotName?: string; target?: string; description?: string },
  opts?: ClientOptions,
): Promise<{ slot: string }> {
  return requestJson<{ slot: string }>(`/api/features/${encodeURIComponent(name)}/envsets/slots`, 'POST', body, opts)
}

export async function deleteEnvsetSlot(
  name: string,
  slot: string,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets/slots/${encodeURIComponent(slot)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export interface FsBrowseResponse {
  dir: string
  parent: string | null
  entries: Array<{ name: string; isDir: boolean }>
}

export function browseDir(dir: string, opts?: ClientOptions): Promise<FsBrowseResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
  return request<FsBrowseResponse>(
    `${baseUrl}/api/fs/browse${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export interface ReadDotenvResponse {
  path: string
  entries: { key: string; value: string }[]
  unparsedLines: number[]
}

export function readDotenvFile(filePath: string, opts?: ClientOptions): Promise<ReadDotenvResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ReadDotenvResponse>(
    `${baseUrl}/api/fs/read-dotenv?path=${encodeURIComponent(filePath)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function putEnvsetSlot(
  name: string,
  env: string,
  slot: string,
  entries: { key: string; value: string }[],
  opts?: ClientOptions,
): Promise<EnvsetSlotDoc> {
  return requestJson<EnvsetSlotDoc>(`/api/features/${encodeURIComponent(name)}/envsets/${encodeURIComponent(env)}/${encodeURIComponent(slot)}`, 'PUT', { entries }, opts)
}

// ─── project config ───────────────────────────────────────────────────────

export interface PortChangeResult {
  restarting: boolean
  port?: number
  newOrigin?: string
  reason?: string
  needsConfirm?: boolean
  activeRuns?: number
}

export function getProjectConfig(opts?: ClientOptions): Promise<ProjectConfigResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ProjectConfigResponse>(`${baseUrl}/api/project-config`, { method: 'GET' }, fetchImpl)
}

/** CLI presence/auth/version and discoverable models behind the model-cockpit
 *  surfaces. `fresh` skips the server's 30s cache. */
export function getAgentProbe(fresh = false, opts?: ClientOptions): Promise<AgentProbeSnapshotResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<AgentProbeSnapshotResponse>(
    `${baseUrl}/api/agent-probe${fresh ? '?fresh=1' : ''}`,
    { method: 'GET' },
    fetchImpl,
  )
}

/** What `init`'s own demonstration still looks like on disk — the first-run
 *  guide's only server input. Derived per call; the samples are disposable, so
 *  deleting one retires its guide step on the next read. */
export function getOnboardingSamples(opts?: ClientOptions): Promise<OnboardingSamples> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<OnboardingSamples>(`${baseUrl}/api/onboarding`, { method: 'GET' }, fetchImpl)
}

export function putProjectConfig(
  config: Partial<ProjectConfigResponse>,
  opts?: ClientOptions,
): Promise<ProjectConfigResponse> {
  return requestJson<ProjectConfigResponse>(`/api/project-config`, 'PUT', config, opts)
}

// Change the UI/MCP port. The server persists it and restarts the UI; a 409
// surfaces as `{ needsConfirm, activeRuns }` so the caller can re-submit with
// confirm:true after warning that active runs will be aborted.
export async function changeProjectPort(
  port: number,
  confirm: boolean,
  opts?: ClientOptions,
): Promise<PortChangeResult> {
  try {
    return await requestJson<PortChangeResult>(`/api/project-config/port`, 'POST', { port, confirm }, opts)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body && typeof e.body === 'object') {
      return e.body as PortChangeResult
    }
    throw e
  }
}
