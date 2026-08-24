// Feature + project configuration: config docs, Playwright, envsets, ports.
// Split out of client.ts; see that barrel for the shared surface.

import type { FeatureTests } from './types'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'

export function getFeatureTests(name: string, opts?: ClientOptions): Promise<FeatureTests> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FeatureTests>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/tests`,
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ParsedConfigDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/config-doc`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    fetchImpl,
  )
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName }),
    },
    fetchImpl,
  )
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ParsedConfigDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/playwright`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    fetchImpl,
  )
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

export function getMcpHealth(profile = 'repair', opts?: ClientOptions): Promise<McpHealth> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<McpHealth>(
    `${baseUrl}/mcp/health?profile=${encodeURIComponent(profile)}`,
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ env: string }>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env }),
    },
    fetchImpl,
  )
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ slot: string }>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets/slots`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EnvsetSlotDoc>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/envsets/${encodeURIComponent(env)}/${encodeURIComponent(slot)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    },
    fetchImpl,
  )
}

// ─── project config ───────────────────────────────────────────────────────

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual' | 'external'
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'system'

export interface ProjectConfig {
  healAgent: HealAgentChoice
  editor: EditorChoice
  personalWikiPath: string | null
  /** Open a draft PR automatically when a run heals green. Declared here because
   *  SettingsModal has always read and written it — the field was live on the
   *  server and in the UI but missing from this mirror, which `apps/web` never
   *  caught (the build tsconfig covers `shared`/`cli`/runtime only). */
  autoProposePr?: boolean
  /** Offer Getting Started from the status bar. The historical field name is
   *  retained for config compatibility; runnable fixtures now sit inside the
   *  guided Getting Started journey. Workspace-level, so turning it off
   *  settles it for the project rather than one browser. Optional for the same
   *  reason `autoProposePr` is: an older server omits it, and every reader tests
   *  `!== false` so absent means on. */
  showDemo?: boolean
  port?: number
}

export type OnboardingWorkflowId = 'run' | 'flight' | 'coverage' | 'export' | 'author' | 'verify' | 'portify'

export type OnboardingWorkflowAction =
  | { kind: 'run'; feature: string }
  | { kind: 'flight'; repoPath: string; description: string }
  | { kind: 'coverage'; feature: string }
  | { kind: 'export'; feature: string }
  | { kind: 'author'; feature: string }
  | { kind: 'verify'; feature: string }
  | { kind: 'portify'; feature: string }

export interface OnboardingWorkflow {
  id: OnboardingWorkflowId
  group: 'start' | 'more'
  order: number
  title: string
  outcome: string
  steps: string[]
  skill: string
  externalPrompt: string
  internalAction: OnboardingWorkflowAction | null
  unavailableReason: string | null
}

/** Mirrors the server union (config/logic/getting-started-session.ts) — one
 *  key per Getting Started card, the two starters plus the five workflows. */
export type GettingStartedWorkflow = 'run' | 'flight' | 'coverage' | 'author' | 'portify' | 'verify' | 'export'
export type GettingStartedOwner = 'internal' | 'external'
/** run/flight are featureless (pre-widening persisted records); the newer
 *  kinds carry `feature` because their open-target navigation is feature-first. */
export type GettingStartedTarget =
  | { kind: 'run'; id: string }
  | { kind: 'flight'; id: string }
  | { kind: 'draft'; id: string; feature: string }
  | { kind: 'coverage-job'; id: string; feature: string }
  | { kind: 'portify'; id: string; feature: string }
  | { kind: 'export'; id: string; feature: string }

export interface GettingStartedActiveSession {
  sessionId: string
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget | null
  startedAt: string
  updatedAt: string
}

export interface GettingStartedCompletion {
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget
  status: string
  startedAt: string
  endedAt: string
}

export interface GettingStartedSessionState {
  active: GettingStartedActiveSession | null
  completed: Partial<Record<GettingStartedWorkflow, GettingStartedCompletion>>
}

/** Mirrors the server's `OnboardingSamples` (config/routes/onboarding.ts). */
export interface OnboardingSamples {
  /** The shipped worked suite, or null once it (or its product repo) is gone. */
  sampleSuite: string | null
  /** Absolute path to the bare repo a Flight can onboard, or null once deleted. */
  sampleFlightRepo: string | null
  /** Prefill for that Flight's "what should it test?" field. */
  sampleFlightDescription: string | null
  /** Ordered, executable workflows for the Getting Started guide. */
  workflows: OnboardingWorkflow[]
  /** Shared internal/external demo activity and latest evidence. */
  session: GettingStartedSessionState
}

export interface PortChangeResult {
  restarting: boolean
  port?: number
  newOrigin?: string
  reason?: string
  needsConfirm?: boolean
  activeRuns?: number
}

export function getProjectConfig(opts?: ClientOptions): Promise<ProjectConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ProjectConfig>(`${baseUrl}/api/project-config`, { method: 'GET' }, fetchImpl)
}

/** What `init`'s own demonstration still looks like on disk — the first-run
 *  guide's only server input. Derived per call; the samples are disposable, so
 *  deleting one retires its guide step on the next read. */
export function getOnboardingSamples(opts?: ClientOptions): Promise<OnboardingSamples> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<OnboardingSamples>(`${baseUrl}/api/onboarding`, { method: 'GET' }, fetchImpl)
}

export function putProjectConfig(
  config: Partial<ProjectConfig>,
  opts?: ClientOptions,
): Promise<ProjectConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ProjectConfig>(
    `${baseUrl}/api/project-config`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    },
    fetchImpl,
  )
}

// Change the UI/MCP port. The server persists it and restarts the UI; a 409
// surfaces as `{ needsConfirm, activeRuns }` so the caller can re-submit with
// confirm:true after warning that active runs will be aborted.
export async function changeProjectPort(
  port: number,
  confirm: boolean,
  opts?: ClientOptions,
): Promise<PortChangeResult> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<PortChangeResult>(
      `${baseUrl}/api/project-config/port`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, confirm }),
      },
      fetchImpl,
    )
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body && typeof e.body === 'object') {
      return e.body as PortChangeResult
    }
    throw e
  }
}
