// Workspace-level actions: editor/app launch, filesystem browse, git, version.
// Split out of client.ts; see that barrel for the shared surface.

import type { VersionStatus, UpdateJobManifest } from './types'
import { defaultOpts, request, type ClientOptions } from './internal'
import type { EditorChoice } from './config'

// Current vs latest published version + the self-update job state.
export function getVersionStatus(opts?: ClientOptions): Promise<VersionStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VersionStatus>(`${baseUrl}/api/version`, { method: 'GET' }, fetchImpl)
}

// Start the package install + workspace migration. Returns the running job
// manifest (202). A 409 means there's nothing newer or an update is already in
// flight — its `{ error }` surfaces as the thrown ApiError message.
export function startVersionUpdate(opts?: ClientOptions): Promise<UpdateJobManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  // No body — declaring application/json with an empty body makes Fastify
  // reject the request (FST_ERR_CTP_EMPTY_JSON_BODY) before the handler runs.
  return request<UpdateJobManifest>(
    `${baseUrl}/api/version/update`,
    { method: 'POST' },
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

// Opens the whole project root (the workspace repo) in the configured editor.
// `opened: false` (with `error`) on a best-effort launch failure — never rejects.
export function openWorkspace(
  opts?: ClientOptions,
): Promise<{ opened: boolean; path: string; editor?: EditorChoice; error?: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/open-workspace`, { method: 'POST' }, fetchImpl)
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
