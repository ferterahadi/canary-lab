import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig, RepoPrerequisite } from '../../../shared/launcher/types'

export interface GitStatus {
  isGitRepo: boolean
  currentBranch: string | null
  detached: boolean
  dirty: boolean
  dirtyFiles: string[]
  localBranches: string[]
  remoteBranches: string[]
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : error
          ? 1
          : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
  })
}

export function resolveRepoPath(localPath: string): string {
  if (localPath === '~') return os.homedir()
  if (localPath.startsWith('~/')) return path.join(os.homedir(), localPath.slice(2))
  return localPath
}

export function parsePorcelainStatus(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

export function parseRefList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function safeBranchName(branch: string): boolean {
  return branch.length > 0
    && !branch.startsWith('-')
    && !branch.includes('\0')
    && !branch.includes('\n')
    && !branch.includes('\r')
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  const target = resolveRepoPath(repoPath)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return emptyGitStatus()
  }

  const inside = await runGit(target, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return emptyGitStatus()
  }

  const [branch, status, locals, remotes] = await Promise.all([
    runGit(target, ['branch', '--show-current']),
    runGit(target, ['status', '--porcelain']),
    runGit(target, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(target, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
  ])

  const currentBranch = branch.stdout.trim() || null
  const dirtyFiles = parsePorcelainStatus(status.stdout)
  return {
    isGitRepo: true,
    currentBranch,
    detached: currentBranch === null,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    localBranches: parseRefList(locals.stdout),
    remoteBranches: parseRefList(remotes.stdout).filter((ref) => !ref.endsWith('/HEAD')),
  }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<GitStatus> {
  const target = resolveRepoPath(repoPath)
  if (!safeBranchName(branch)) {
    throw Object.assign(new Error('branch must be a non-empty branch name'), { statusCode: 400 })
  }

  const status = await getGitStatus(target)
  if (!status.isGitRepo) {
    throw Object.assign(new Error('path is not a git repository'), { statusCode: 400 })
  }
  if (status.dirty) {
    throw Object.assign(new Error('repo has uncommitted changes'), { statusCode: 409 })
  }
  if (status.currentBranch === branch) return status

  const result = await runGit(target, ['checkout', branch])
  if (result.code !== 0) {
    throw Object.assign(
      new Error((result.stderr || result.stdout).trim() || 'git checkout failed'),
      { statusCode: 500 },
    )
  }
  return getGitStatus(target)
}

export async function collectRepoBranchSnapshots(feature: FeatureConfig): Promise<RepoBranchSnapshot[]> {
  const out: RepoBranchSnapshot[] = []
  for (const repo of feature.repos ?? []) {
    const localPath = repo.localPath
    if (typeof localPath !== 'string') continue
    const repoPath = resolveRepoPath(localPath)
    const status = await getGitStatus(repoPath)
    if (!status.isGitRepo) continue
    out.push({
      name: repo.name,
      path: repoPath,
      branch: status.currentBranch,
      expectedBranch: repo.branch,
      detached: status.detached,
      dirty: status.dirty,
    })
  }
  return out
}

export async function validateConfiguredRepoBranches(feature: FeatureConfig): Promise<void> {
  const failures: string[] = []
  for (const repo of feature.repos ?? []) {
    const expected = repo.branch
    if (!expected) continue
    const localPath = repo.localPath
    if (typeof localPath !== 'string') continue
    const repoPath = resolveRepoPath(localPath)
    const status = await getGitStatus(repoPath)
    if (!status.isGitRepo) {
      failures.push(`${repo.name}: ${repoPath} is not a git repository`)
      continue
    }
    if (status.detached) {
      failures.push(`${repo.name}: expected ${expected}, but checkout is detached`)
      continue
    }
    if (status.currentBranch !== expected) {
      failures.push(`${repo.name}: expected ${expected}, current ${status.currentBranch ?? '(none)'}`)
    }
  }
  if (failures.length > 0) {
    throw Object.assign(
      new Error(`Repo branch check failed:\n${failures.join('\n')}`),
      { statusCode: 409 },
    )
  }
}

function emptyGitStatus(): GitStatus {
  return {
    isGitRepo: false,
    currentBranch: null,
    detached: false,
    dirty: false,
    dirtyFiles: [],
    localBranches: [],
    remoteBranches: [],
  }
}

export function findRepo(feature: FeatureConfig, name: string): RepoPrerequisite | null {
  return (feature.repos ?? []).find((repo) => repo.name === name) ?? null
}
