// Typed fetch wrappers around the Fastify server's REST endpoints. Pure
// functions — they accept a `fetch` impl via injection so tests can stub it.
// Production callers use the default (the global `fetch`).

import type {
  AuditList,
  Feature,
  FeatureTests,
  RunIndexEntry,
  CleanupListing,
  CleanupWorktree,
  RunDetail,
  JournalEntry,
  CreateDraftPayload,
  CreateDraftResponse,
  DraftRecord,
  EvaluationExportMode,
  EvaluationExportTask,
  PlanStep,
  DraftPrdDocument,
  VerificationConfig,
  VerificationTarget,
} from './types'
import type {
  BenchmarkIndexEntry,
  BenchmarkManifest,
  SabotageLevel,
  SabotageSkillSummary,
} from './benchmark-types'

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
    // Surface the server's `{ error }` message (most routes return one) as the
    // Error message so callers showing `e.message` get the real reason, not a
    // bare "HTTP 409".
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : undefined
    throw new ApiError(res.status, body, message)
  }
  return body as T
}

export function listFeatures(opts?: ClientOptions): Promise<Feature[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<Feature[]>(`${baseUrl}/api/features`, { method: 'GET' }, fetchImpl)
}

// ─── Benchmark ─────────────────────────────────────────────────────────────

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

export function getBenchmarkSabotageLog(id: string, opts?: ClientOptions): Promise<{ log: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ log: string }>(
    `${baseUrl}/api/benchmarks/${encodeURIComponent(id)}/sabotage-log`,
    { method: 'GET' },
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

export type PortifyStatus =
  | 'planning' | 'editing' | 'verifying' | 'ready-to-commit'
  | 'committed' | 'failed' | 'aborted'

export interface PortifyBootInstance {
  ports: Record<string, number>
  ok: boolean
  failedService?: string
  detail?: string
}

export interface PortifyRepoState {
  name: string
  path: string
  worktreePath?: string
  baseSha?: string
  commitSha?: string
}

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  startedAt: string
  endedAt?: string
}

export interface PortifyManifest {
  workflowId: string
  feature: string
  repos: PortifyRepoState[]
  agent: 'claude' | 'codex'
  branch: string
  status: PortifyStatus
  attempt: number
  maxAttempts: number
  feedbackRounds?: number
  startedAt: string
  endedAt?: string
  diff?: string
  verification?: { ok: boolean; instances: PortifyBootInstance[]; failureDetail?: string }
  error?: string
}

export function startPortify(
  input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number },
  opts?: ClientOptions,
): Promise<{ workflowId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ workflowId: string }>(
    `${baseUrl}/api/portify`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    fetchImpl,
  )
}

export function getPortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function commitPortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/commit`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function cancelPortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/cancel`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function revisePortify(
  workflowId: string,
  feedback: string,
  opts?: ClientOptions,
): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/revise`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) },
    fetchImpl,
  )
}

export async function getPortifyAgentSession(
  workflowId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
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
  port?: number
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

export function openEditor(
  target: { file: string; line?: number; column?: number; editor?: EditorChoice },
  opts?: ClientOptions,
): Promise<{ opened: boolean; editor: EditorChoice }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ opened: boolean; editor: EditorChoice }>(
    `${baseUrl}/api/open-editor`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target),
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

export function getWorkspaceGitStatus(
  absolutePath: string,
  opts?: ClientOptions,
): Promise<GitRepoStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<GitRepoStatus>(
    `${baseUrl}/api/workspace/git-status?path=${encodeURIComponent(absolutePath)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function checkoutWorkspaceBranch(
  absolutePath: string,
  branch: string,
  opts?: ClientOptions,
): Promise<GitRepoStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<GitRepoStatus>(
    `${baseUrl}/api/workspace/checkout`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: absolutePath, branch }),
    },
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

export interface GitRepoStatus {
  path: string
  expectedBranch: string | null
  isGitRepo: boolean
  currentBranch: string | null
  detached: boolean
  dirty: boolean
  dirtyFiles: string[]
  localBranches: string[]
  remoteBranches: string[]
}

export function getRepoGitStatus(
  feature: string,
  repo: string,
  opts?: ClientOptions,
): Promise<GitRepoStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<GitRepoStatus>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/repos/${encodeURIComponent(repo)}/git`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function checkoutRepoBranch(
  feature: string,
  repo: string,
  branch: string,
  opts?: ClientOptions,
): Promise<GitRepoStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<GitRepoStatus>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/repos/${encodeURIComponent(repo)}/checkout`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch }),
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

export function getRunAudit(runId: string, opts?: ClientOptions): Promise<AuditList> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<AuditList>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/audit`,
    { method: 'GET' },
    fetchImpl,
  )
}

export interface VerificationTargetIndex {
  targets: VerificationTarget[]
  targetUrls: Record<string, string>
}

export function getVerificationTargets(
  feature: string,
  envset?: string,
  opts?: ClientOptions,
): Promise<VerificationTargetIndex> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = envset ? `?envset=${encodeURIComponent(envset)}` : ''
  return request<VerificationTargetIndex>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-targets${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listVerificationConfigs(
  feature: string,
  opts?: ClientOptions,
): Promise<VerificationConfig[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig[]>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function createVerificationConfig(
  feature: string,
  body: { name: string; targetUrls: Record<string, string>; playwrightEnvsetId: string },
  opts?: ClientOptions,
): Promise<VerificationConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function updateVerificationConfig(
  feature: string,
  configId: string,
  body: { name: string; targetUrls: Record<string, string>; playwrightEnvsetId: string },
  opts?: ClientOptions,
): Promise<VerificationConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs/${encodeURIComponent(configId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function executeVerification(
  feature: string,
  body: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  opts?: ClientOptions,
): Promise<{ runId: string; executionType: 'verify' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ runId: string; executionType: 'verify' }>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verifications`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function startEvaluationExport(
  runId: string,
  mode: EvaluationExportMode,
  opts?: ClientOptions,
): Promise<EvaluationExportTask> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTask>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/evaluation-export`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    fetchImpl,
  )
}

export function getEvaluationExportTask(
  taskId: string,
  opts?: ClientOptions,
): Promise<EvaluationExportTask> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTask>(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listEvaluationExportTasks(
  query: { runId?: string } = {},
  opts?: ClientOptions,
): Promise<EvaluationExportTask[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.runId ? `?runId=${encodeURIComponent(query.runId)}` : ''
  return request<EvaluationExportTask[]>(
    `${baseUrl}/api/evaluation-exports${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export async function cancelEvaluationExportTask(
  taskId: string,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function downloadEvaluationExportTask(
  task: EvaluationExportTask,
  opts: ClientOptions & {
    documentRef?: Document
    urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  } = {},
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const documentRef = opts.documentRef ?? document
  const urlApi = opts.urlApi ?? URL
  const res = await fetchImpl(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    { method: 'GET' },
  )
  if (!res.ok) throw new ApiError(res.status, await readResponseBody(res))
  const href = urlApi.createObjectURL(await res.blob())
  const link = documentRef.createElement('a')
  try {
    link.href = href
    link.download = evaluationExportFilename(task.feature, task.runId)
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    urlApi.revokeObjectURL(href)
  }
}

function evaluationExportFilename(feature: string, runId: string): string {
  return `canary-lab-evaluation-${safeFilename(feature)}-${safeFilename(runId)}.zip`
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// Structured heal-agent session view (claude/codex JSONL parsed + normalized
// into a uniform event stream). 404 on the API maps to `null` here so the UI
// can fall back to the raw transcript replay without try/catch noise.
export type AgentSessionEvent =
  | { kind: 'user-message'; timestamp: string; text: string }
  | { kind: 'assistant-message'; timestamp: string; text: string }
  | { kind: 'assistant-thinking'; timestamp: string; text: string }
  | { kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }
  | { kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }

export interface AgentSessionResponse {
  agent: 'claude' | 'codex'
  sessionId: string
  // Model the agent ran (both agents) and reasoning effort (codex only).
  model?: string
  effort?: string
  events: AgentSessionEvent[]
}

export async function getAgentSession(
  runId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function getDraftAgentSession(
  draftId: string,
  stage: 'planning' | 'generating',
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/tests/draft/${encodeURIComponent(draftId)}/agent-session?stage=${encodeURIComponent(stage)}`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

// Body of the 409 the server returns when a start request hits a same-repo
// collision and the caller hasn't chosen how to handle it.
export interface RepoCollisionChoice {
  type: 'repo_collision_requires_choice'
  conflictingRunId: string
  conflictingFeature: string
  repoPaths: string[]
  options: Array<'worktree' | 'queue'>
  message: string
}

/** Returns the collision payload when `err` is the 409 collision-choice
 *  ApiError, else null. */
export function asRepoCollision(err: unknown): RepoCollisionChoice | null {
  if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === 'object'
    && (err.body as { type?: string }).type === 'repo_collision_requires_choice') {
    return err.body as RepoCollisionChoice
  }
  return null
}

export function startRun(
  feature: string,
  opts?: ClientOptions & { env?: string; isolation?: 'worktree' | 'queue'; mode?: 'test' | 'boot' },
): Promise<{ runId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body: Record<string, unknown> = { feature }
  if (opts?.env) body.env = opts.env
  if (opts?.isolation) body.isolation = opts.isolation
  if (opts?.mode === 'boot') body.mode = 'boot'
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
): Promise<{ status: 'sent' | 'restarted' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'sent' | 'restarted' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-input`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    },
    fetchImpl,
  )
}

export function restartRun(
  runId: string,
  opts?: ClientOptions,
): Promise<{ status: 'restarted'; mode: 'remaining' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'restarted'; mode: 'remaining' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/restart`,
    { method: 'POST' },
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

export async function deleteJournalEntry(
  iteration: number,
  query: { run?: string } = {},
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const params = new URLSearchParams()
  if (query.run) params.set('run', query.run)
  const qs = params.toString() ? `?${params.toString()}` : ''
  await request<unknown>(
    `${baseUrl}/api/journal/${encodeURIComponent(String(iteration))}${qs}`,
    { method: 'DELETE' },
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

export function listDrafts(opts?: ClientOptions): Promise<DraftRecord[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<DraftRecord[]>(
    `${baseUrl}/api/tests/draft`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function extractPrdDocuments(
  payload: { prdText?: string; files: File[] },
  opts?: ClientOptions,
): Promise<{ prdText: string; documents: DraftPrdDocument[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const form = new FormData()
  if (payload.prdText) form.append('prdText', payload.prdText)
  for (const file of payload.files) form.append('files', file)
  return request<{ prdText: string; documents: DraftPrdDocument[] }>(
    `${baseUrl}/api/tests/prd-documents`,
    { method: 'POST', body: form },
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

export function getDraftAgentLog(
  id: string,
  stage: 'planning' | 'generating',
  opts?: ClientOptions,
): Promise<{ content: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ content: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/agent-log?stage=${encodeURIComponent(stage)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function cancelDraftGeneration(
  id: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: DraftRecord['status'] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: DraftRecord['status'] }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/cancel-generation`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function acceptPlan(
  id: string,
  plan?: PlanStep[],
  intentSummary?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body: { plan?: PlanStep[]; intentSummary?: string } = {}
  if (plan) body.plan = plan
  if (intentSummary !== undefined) body.intentSummary = intentSummary
  return request<{ draftId: string; status: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-plan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function acceptSpec(
  id: string,
  featureName?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string; featureDir: string; devDependenciesAdded?: string[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string; featureDir: string; devDependenciesAdded?: string[] }>(
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
