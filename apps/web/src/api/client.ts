// Typed fetch wrappers around the Fastify server's REST endpoints. Pure
// functions — they accept a `fetch` impl via injection so tests can stub it.
// Production callers use the default (the global `fetch`).

import type {
  Feature,
  FeatureTests,
  RunIndexEntry,
  RunDetail,
  JournalEntry,
  SkillSummary,
  SkillRecommendation,
  CreateDraftPayload,
  CreateDraftResponse,
  DraftRecord,
  PlanStep,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
}

const defaultOpts = (opts?: ClientOptions): Required<ClientOptions> => ({
  baseUrl: opts?.baseUrl ?? '',
  fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
})

async function request<T>(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<T> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, body)
  }
  return body as T
}

export function listFeatures(opts?: ClientOptions): Promise<Feature[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<Feature[]>(`${baseUrl}/api/features`, { method: 'GET' }, fetchImpl)
}

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

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual'

export interface ProjectConfig {
  healAgent: HealAgentChoice
}

export function getProjectConfig(opts?: ClientOptions): Promise<ProjectConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<ProjectConfig>(`${baseUrl}/api/project-config`, { method: 'GET' }, fetchImpl)
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

export function openAgentApp(agent: 'claude' | 'codex', opts?: ClientOptions): Promise<{ opened: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ opened: boolean }>(
    `${baseUrl}/api/open-agent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent }),
    },
    fetchImpl,
  )
}

// ─── workspace folder picker ──────────────────────────────────────────────

export interface WorkspaceDirsResponse {
  root: string
  at: string
  absolute?: string
  parent?: string | null
  dirs: string[]
}

export function listWorkspaceDirs(
  at: string = '',
  opts?: ClientOptions,
): Promise<WorkspaceDirsResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = at ? `?at=${encodeURIComponent(at)}` : ''
  return request<WorkspaceDirsResponse>(
    `${baseUrl}/api/workspace/dirs${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getGitRemote(
  absolutePath: string,
  opts?: ClientOptions,
): Promise<{ cloneUrl: string | null }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ cloneUrl: string | null }>(
    `${baseUrl}/api/workspace/git-remote?path=${encodeURIComponent(absolutePath)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function checkPathExists(
  absolutePath: string,
  opts?: ClientOptions,
): Promise<{ exists: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ exists: boolean }>(
    `${baseUrl}/api/workspace/path-exists?path=${encodeURIComponent(absolutePath)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function cloneRepository(
  body: { cloneUrl: string; parentDir: string; repoName: string },
  opts?: ClientOptions,
): Promise<{ localPath: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ localPath: string }>(
    `${baseUrl}/api/workspace/clone`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function listRuns(
  query: { feature?: string } = {},
  opts?: ClientOptions,
): Promise<RunIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.feature ? `?feature=${encodeURIComponent(query.feature)}` : ''
  return request<RunIndexEntry[]>(`${baseUrl}/api/runs${qs}`, { method: 'GET' }, fetchImpl)
}

export function getRunDetail(runId: string, opts?: ClientOptions): Promise<RunDetail> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RunDetail>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function startRun(
  feature: string,
  opts?: ClientOptions & { env?: string },
): Promise<{ runId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body = opts?.env ? { feature, env: opts.env } : { feature }
  return request<{ runId: string }>(
    `${baseUrl}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

// Mid-Run Heal: ask the server to interrupt a running test and start the heal
// agent immediately. Resolves with `{ status, failureCount }` on a 202;
// throws ApiError on 409 (the body's `reason` describes which precondition
// failed) or 404 (run not active).
export interface PauseHealSuccess {
  status: 'healing'
  failureCount: number
}

export function pauseHealRun(runId: string, opts?: ClientOptions): Promise<PauseHealSuccess> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PauseHealSuccess>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/pause-heal`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Cancel an in-flight heal cycle. Server SIGTERMs the agent, breaks the
// heal loop, and appends a journal entry. Resolves on 202; ApiError on 409
// (no agent running / not currently healing) or 404 (run not active).
export function cancelHealRun(runId: string, opts?: ClientOptions): Promise<{ status: 'cancelled' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'cancelled' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/cancel-heal`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function sendAgentInput(
  runId: string,
  data: string,
  opts?: ClientOptions,
): Promise<{ status: 'sent' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'sent' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-input`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    },
    fetchImpl,
  )
}

// Abort an active run. POSTs to the abort endpoint which kills Playwright,
// the heal agent, and any service ptys, then marks the manifest 'aborted'.
// History is preserved — use `deleteRun` afterwards to hard-remove the logs.
export async function stopRun(runId: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/abort`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Hard-remove a terminal run from history: drops the index entry and
// recursively deletes the run directory. Server returns 409 if the run is
// still active — callers must abort first.
export async function deleteRun(runId: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function deleteJournalEntry(
  iteration: number,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/journal/${encodeURIComponent(String(iteration))}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export function listSkills(opts?: ClientOptions): Promise<SkillSummary[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<SkillSummary[]>(`${baseUrl}/api/skills`, { method: 'GET' }, fetchImpl)
}

export function recommendSkills(
  body: { prdText: string; topN?: number },
  opts?: ClientOptions,
): Promise<SkillRecommendation[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<SkillRecommendation[]>(
    `${baseUrl}/api/skills/recommend`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function createDraft(
  payload: CreateDraftPayload,
  opts?: ClientOptions,
): Promise<CreateDraftResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CreateDraftResponse>(
    `${baseUrl}/api/tests/draft`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    fetchImpl,
  )
}

export interface DraftFile {
  path: string
  content: string
  mime: string
}

// Fetch a single generated file inside a draft for the wizard's Spec Review
// step. The server enforces path-traversal hardening; this client just
// percent-encodes each segment so slashes remain in the URL.
export function getDraftFile(
  id: string,
  filePath: string,
  opts?: ClientOptions,
): Promise<DraftFile> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const safe = filePath.split('/').map(encodeURIComponent).join('/')
  return request<DraftFile>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/files/${safe}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getDraft(id: string, opts?: ClientOptions): Promise<DraftRecord> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<DraftRecord>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function acceptPlan(
  id: string,
  plan?: PlanStep[],
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-plan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plan ? { plan } : {}),
    },
    fetchImpl,
  )
}

export function acceptSpec(
  id: string,
  featureName?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string; featureDir: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string; featureDir: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-spec`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(featureName ? { featureName } : {}),
    },
    fetchImpl,
  )
}

export async function rejectDraft(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/reject`,
    { method: 'POST' },
    fetchImpl,
  )
}

export async function deleteDraft(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export function listJournal(
  query: { feature?: string; run?: string } = {},
  opts?: ClientOptions,
): Promise<JournalEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const params = new URLSearchParams()
  if (query.feature) params.set('feature', query.feature)
  if (query.run) params.set('run', query.run)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<JournalEntry[]>(`${baseUrl}/api/journal${qs}`, { method: 'GET' }, fetchImpl)
}
