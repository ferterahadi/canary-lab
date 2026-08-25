import fs from 'fs'
import os from 'os'
import path from 'path'
import { runGit as realRunGit, resolveRepoPath, type GitResult } from '../../../../shared/git-repo'
import { runGh as realRunGh, type GhResult } from '../../../../shared/gh-cli'
import type { RunFixCapture, RunProposedPr } from '../../../../../../../shared/run-state'
import type { PrPreflight } from './pr-preflight'
import type { RunSummaryFailedEntry } from '../run-detail'
import { writeFixCommitMessage, type FixCommitMessage, type FixCommitMessageInput } from './commit-message-agent'

// Open a pull request from a run's captured fix, per pushable repo. Driven
// either by the user (the Propose PR dialog) or automatically at the end of a
// green healed run. The product repo is NEVER touched: the patch is applied in
// a THROWAWAY worktree cut from the run's captured baseSha, committed,
// force-pushed to a deterministic branch, and turned into a PR via
// `gh pr create`. gh's own credential does the push/create; we never see or
// handle the token.
//
// The branch is scoped to FEATURE + repo, not to the run: healing the same
// feature three times keeps ONE pull request carrying the newest fix rather
// than leaving three competing ones open. That makes the push-then-look-up
// order load-bearing — an existing PR is reused only AFTER the new patch has
// been pushed onto its branch, so the PR a reviewer opens is never a stale
// earlier attempt.

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
  /** Override the commit-message agent (tests, and the one seam that keeps this
   *  module spawn-free when nothing needs a message written). */
  writeMessage?: (input: FixCommitMessageInput) => Promise<FixCommitMessage | null>
}

/** Deterministic per feature+repo, so every healed run of a feature updates the
 *  SAME branch — and therefore the same pull request — instead of opening one
 *  per run. The run id lives in the commit message and PR body instead, which
 *  keeps the traceability without multiplying review requests. */
export function fixBranchName(feature: string, repoName: string): string {
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `canary-lab/fix-${slug(feature)}-${slug(repoName)}`
}

export async function proposeFixesForRun(opts: {
  runId: string
  feature: string
  fixCapture: RunFixCapture
  preflight: PrPreflight
  /** Open the PR in GitHub's draft state — no reviewer is requested and no
   *  review notification fires until a human marks it ready. The automatic
   *  end-of-run trigger uses this; the user-driven dialog does not. */
  draft?: boolean
  /** Failing tests from the run, passed through to the message agent as the
   *  evidence for WHY the repair happened. */
  failed?: RunSummaryFailedEntry[]
  deps?: ProposeDeps
}): Promise<ProposeResult[]> {
  const git = opts.deps?.git ?? realRunGit
  const gh = opts.deps?.gh ?? realRunGh
  const now = opts.deps?.now ?? (() => new Date().toISOString())
  const writeMessage = opts.deps?.writeMessage ?? writeFixCommitMessage
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
    const branch = fixBranchName(opts.feature, pre.repoName)
    const repoSlug = `${pre.origin.owner}/${pre.origin.name}`

    const wt = tmpWorktreeDir(opts.runId, pre.repoName)
    // Written from the diff before the worktree exists, so a slow or missing
    // agent costs nothing but the default wording — the scratch tree is not
    // held open while it thinks.
    const written = await writeMessage({
      feature: opts.feature,
      repoName: pre.repoName,
      runId: opts.runId,
      baseSha: fixRepo.baseSha,
      patchPath: fixRepo.patchPath,
      ...(fixRepo.fileNames ? { fileNames: fixRepo.fileNames } : {}),
      ...(opts.failed ? { failed: opts.failed } : {}),
      cwd: repoRoot,
    }).catch(() => null)
    try {
      const outcome = await createPrInWorktree({ git, gh, repoRoot, wt, branch, base: pre.base, repoSlug, baseSha: fixRepo.baseSha, patchPath: fixRepo.patchPath, feature: opts.feature, runId: opts.runId, draft: opts.draft === true, ...(written ? { written } : {}) })
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
  draft: boolean
  /** Agent-written wording for this repair. Absent when no agent could write
   *  one; the deterministic template below then stands in. */
  written?: FixCommitMessage
}): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  // `git push` always leads with `To <remote>` and puts the cause underneath,
  // so the first line alone tells the user nothing. Prefer the `! [rejected]`
  // or `error:` line — but fall back to the FIRST line rather than to a
  // `fatal:` one: a transport failure reads `ssh: Could not resolve hostname …`
  // then `fatal: Could not read from remote repository.`, where the real cause
  // is line 1 and the `fatal:` is boilerplate.
  const fail = (r: GitResult | GhResult, what: string) => {
    const lines = (r.stderr || r.stdout).trim().split('\n').map((l) => l.trim()).filter(Boolean)
    const cause = lines.find((l) => /^(!|error:)/.test(l)) ?? lines[0] ?? ''
    return { ok: false as const, reason: `${what}: ${cause || 'failed'}` }
  }

  const add = await a.git(a.repoRoot, ['worktree', 'add', '--detach', a.wt, a.baseSha || 'HEAD'])
  if (add.code !== 0) return fail(add, 'could not create a scratch worktree')
  // Give `--force-with-lease` something to lease against. The feature-scoped
  // branch usually already exists on origin (an earlier healed run pushed it),
  // and a lease with no remote-tracking ref is rejected as stale info — so the
  // second run of every feature would fail to push without this. A branch that
  // isn't on origin yet simply makes the fetch fail, and the push then creates
  // it.
  await a.git(a.wt, ['fetch', 'origin', `+refs/heads/${a.branch}:refs/remotes/origin/${a.branch}`])
  const branchOut = await a.git(a.wt, ['checkout', '-B', a.branch])
  if (branchOut.code !== 0) return fail(branchOut, 'could not create the fix branch')
  const applied = await a.git(a.wt, ['apply', '--3way', '--whitespace=nowarn', a.patchPath])
  if (applied.code !== 0) return fail(applied, 'the fix no longer applies to the base — rerun to refresh it')
  await a.git(a.wt, ['add', '-A'])
  // Subject and body as separate `-m` args so git composes the blank line
  // between them itself — one folded string would make the whole message the
  // subject line in every log and PR-title default.
  const commit = await a.git(a.wt, [
    'commit',
    '-m', a.written?.commitSubject ?? `fix(${a.feature}): canary-lab heal fixes from run ${a.runId}`,
    ...(a.written ? ['-m', `${a.written.commitBody}\n\nCanary Lab run \`${a.runId}\` · based on \`${a.baseSha.slice(0, 12)}\``] : []),
    '--no-verify',
  ])
  if (commit.code !== 0) return fail(commit, 'nothing to commit / commit failed')
  const push = await a.git(a.wt, ['push', '-u', 'origin', a.branch, '--force-with-lease'])
  if (push.code !== 0) return fail(push, 'push to origin was rejected')
  // Look the PR up only NOW: the branch already carries this run's fix, so a
  // PR found here is the same review thread updated in place rather than a
  // stale earlier attempt short-circuiting the push.
  const existing = await a.gh(['pr', 'list', '--repo', a.repoSlug, '--head', a.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'])
  if (existing.code === 0 && existing.stdout.trim()) return { ok: true, url: existing.stdout.trim() }
  // The provenance footer is appended rather than left to the agent: it is the
  // one part of the body that must be exact, and a written line is a claim the
  // agent could get wrong.
  const provenance = `\n\n---\nCaptured by Canary Lab from run \`${a.runId}\`, based on \`${a.baseSha.slice(0, 12)}\`. Review before merging.`
  const body = a.written
    ? `${a.written.prBody}${provenance}`
    : `Automated fix captured by Canary Lab from run \`${a.runId}\` (based on \`${a.baseSha.slice(0, 12)}\`). Review before merging.`
  const pr = await a.gh([
    'pr', 'create', '--repo', a.repoSlug, '--base', a.base, '--head', a.branch,
    '--title', a.written?.prTitle ?? `fix(${a.feature}): canary-lab heal fixes`, '--body', body,
    ...(a.draft ? ['--draft'] : []),
  ])
  if (pr.code !== 0) return fail(pr, 'gh pr create failed')
  const url = pr.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return url ? { ok: true, url } : { ok: false, reason: 'gh pr create returned no URL' }
}

function slugForDir(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}
