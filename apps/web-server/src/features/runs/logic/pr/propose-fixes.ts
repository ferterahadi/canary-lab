import fs from 'fs'
import os from 'os'
import path from 'path'
import { runGit as realRunGit, resolveRepoPath, type GitResult } from '../../../../shared/git-repo'
import { runGh as realRunGh, type GhResult } from '../../../../shared/gh-cli'
import type { RunFixCapture, RunProposedPr } from '../../../../../../../shared/run-state'
import type { PrPreflight } from './pr-preflight'

// Open a pull request from a run's captured fix, per pushable repo. On demand
// only. The product repo is NEVER touched: the patch is applied in a THROWAWAY
// worktree cut from the run's captured baseSha, committed, force-pushed to a
// deterministic branch, and turned into a PR via `gh pr create`. Idempotent —
// a repeat request finds the existing PR and returns its URL rather than
// opening a duplicate. gh's own credential does the push/create; we never see
// or handle the token.

export interface ProposeResult {
  repoName: string
  ok: boolean
  pr?: RunProposedPr
  /** Why it didn't open, when `ok` is false (conflict, push rejected, etc.). */
  reason?: string
}

export interface ProposeDeps {
  git?: (cwd: string, args: string[]) => Promise<GitResult>
  gh?: (args: string[]) => Promise<GhResult>
  tmpWorktreeDir?: (runId: string, repoName: string) => string
  now?: () => string
}

/** Deterministic per run+repo so a retry targets the same branch/PR (idempotent). */
export function fixBranchName(runId: string, repoName: string): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `canary-lab/fix-${slug(runId)}-${slug(repoName)}`
}

export async function proposeFixesForRun(opts: {
  runId: string
  feature: string
  fixCapture: RunFixCapture
  preflight: PrPreflight
  deps?: ProposeDeps
}): Promise<ProposeResult[]> {
  const git = opts.deps?.git ?? realRunGit
  const gh = opts.deps?.gh ?? realRunGh
  const now = opts.deps?.now ?? (() => new Date().toISOString())
  const tmpWorktreeDir = opts.deps?.tmpWorktreeDir
    ?? ((runId, repoName) => path.join(os.tmpdir(), `canary-pr-${slugForDir(runId)}-${slugForDir(repoName)}`))

  const results: ProposeResult[] = []
  for (const pre of opts.preflight.repos) {
    if (!pre.pushable || !pre.origin || !pre.base) {
      results.push({ repoName: pre.repoName, ok: false, reason: pre.blocked?.reason ?? 'repo is not pushable' })
      continue
    }
    const fixRepo = opts.fixCapture.repos.find((r) => r.repoName === pre.repoName)
    if (!fixRepo) {
      results.push({ repoName: pre.repoName, ok: false, reason: 'no captured patch for this repo' })
      continue
    }
    const repoRoot = resolveRepoPath(fixRepo.repoRoot)
    const branch = fixBranchName(opts.runId, pre.repoName)
    const repoSlug = `${pre.origin.owner}/${pre.origin.name}`

    // Idempotent: an existing PR for this head short-circuits everything.
    const existing = await gh(['pr', 'list', '--repo', repoSlug, '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'])
    if (existing.code === 0 && existing.stdout.trim()) {
      results.push({ repoName: pre.repoName, ok: true, pr: { repoName: pre.repoName, url: existing.stdout.trim(), branch, base: pre.base, createdAt: now() } })
      continue
    }

    const wt = tmpWorktreeDir(opts.runId, pre.repoName)
    try {
      const outcome = await createPrInWorktree({ git, gh, repoRoot, wt, branch, base: pre.base, repoSlug, baseSha: fixRepo.baseSha, patchPath: fixRepo.patchPath, feature: opts.feature, runId: opts.runId })
      results.push(outcome.ok
        ? { repoName: pre.repoName, ok: true, pr: { repoName: pre.repoName, url: outcome.url, branch, base: pre.base, createdAt: now() } }
        : { repoName: pre.repoName, ok: false, reason: outcome.reason })
    } finally {
      // Always drop the throwaway worktree, however far we got.
      await git(repoRoot, ['worktree', 'remove', '--force', wt]).catch(() => undefined)
      try { if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  return results
}

async function createPrInWorktree(a: {
  git: (cwd: string, args: string[]) => Promise<GitResult>
  gh: (args: string[]) => Promise<GhResult>
  repoRoot: string
  wt: string
  branch: string
  base: string
  repoSlug: string
  baseSha: string
  patchPath: string
  feature: string
  runId: string
}): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const fail = (r: GitResult | GhResult, what: string) => ({ ok: false as const, reason: `${what}: ${(r.stderr || r.stdout).trim().split('\n')[0] || 'failed'}` })

  const add = await a.git(a.repoRoot, ['worktree', 'add', '--detach', a.wt, a.baseSha || 'HEAD'])
  if (add.code !== 0) return fail(add, 'could not create a scratch worktree')
  const branchOut = await a.git(a.wt, ['checkout', '-B', a.branch])
  if (branchOut.code !== 0) return fail(branchOut, 'could not create the fix branch')
  const applied = await a.git(a.wt, ['apply', '--3way', '--whitespace=nowarn', a.patchPath])
  if (applied.code !== 0) return fail(applied, 'the fix no longer applies to the base — rerun to refresh it')
  await a.git(a.wt, ['add', '-A'])
  const commit = await a.git(a.wt, ['commit', '-m', `fix(${a.feature}): canary-lab heal fixes from run ${a.runId}`, '--no-verify'])
  if (commit.code !== 0) return fail(commit, 'nothing to commit / commit failed')
  const push = await a.git(a.wt, ['push', '-u', 'origin', a.branch, '--force-with-lease'])
  if (push.code !== 0) return fail(push, 'push to origin was rejected')
  const body = `Automated fix captured by Canary Lab from run \`${a.runId}\` (based on \`${a.baseSha.slice(0, 12)}\`). Review before merging.`
  const pr = await a.gh(['pr', 'create', '--repo', a.repoSlug, '--base', a.base, '--head', a.branch, '--title', `fix(${a.feature}): canary-lab heal fixes`, '--body', body])
  if (pr.code !== 0) return fail(pr, 'gh pr create failed')
  const url = pr.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return url ? { ok: true, url } : { ok: false, reason: 'gh pr create returned no URL' }
}

function slugForDir(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}
