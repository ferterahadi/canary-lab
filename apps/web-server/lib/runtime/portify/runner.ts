import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { type ChildProcess } from 'child_process'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../shared/launcher/types'
import { runGit, resolveRepoPath, snapshotWorkingTree, getGitRoot } from '../../git-repo'
import type { PtyFactory } from '../pty-spawner'
import type { HealAgent } from '../auto-heal'
import { generateRunId } from '../run-id'
import { removeWorktree, type WorktreeHandle } from '../repo-worktree'
import { PortifyRunStore } from './store'
import { PortifyOrchestrator } from './orchestrator'
import { buildPortifyPaths, portifyDir } from './paths'
import { createBranchAndWorktree, captureDiff, changedFiles, commitWorktree, discardWorktree, portifyBranchName } from './git-ops'
import { runPortifyAgent, writePortifyClaudeRef } from './agent'
import { buildPortifyPrompt, buildPortifyRetryPrompt, type RepoEditTarget } from './prompt'
import { verifyDoubleBoot } from './verify'
import type { PortifyManifest, PortifyRepoState, StartPortifyInput, StartPortifyResult } from './types'

// Wires the real I/O behind the (tested) PortifyOrchestrator: a git branch +
// worktree per GIT ROOT, the port-ification agent, the double-boot verifier,
// and the commit/cancel actions the UI drives after run() parks at
// `ready-to-commit`.
//
// Multi-repo: repos are grouped by their git root. A feature can list several
// repos that live in ONE monorepo (different subpaths); git forbids the same
// branch checked out in two worktrees of one repo, so each git root gets ONE
// worktree and every member repo is edited inside it. Distinct roots get
// distinct worktrees. The agent also edits the (canonical, in-place) config.

export interface PortifyRunnerDeps {
  logsDir: string
  store: PortifyRunStore
  ptyFactory: PtyFactory
  loadFeatures: () => FeatureConfig[]
  pickAgent: (preferred?: HealAgent) => HealAgent | null
  now: () => string
  /** Per-service health deadline for the verification boots (ms). */
  healthDeadlineMs?: number
  /** HTTP health attempt — defaulted to the real poller; injectable for tests. */
  healthCheck?: (url: string, timeoutMs?: number) => Promise<boolean>
  /** Verification poll cadence (ms); injectable to keep tests fast. */
  healthPollIntervalMs?: number
}

interface GroupMember {
  name: string
  /** Canonical localPath of this logical repo. */
  path: string
  /** Where to edit this repo's source inside the group's worktree. */
  editPath?: string
}

interface RepoGroup {
  /** Stable worktree-dir key. */
  key: string
  /** Git toplevel shared by every member. */
  sourceRoot: string
  handle?: WorktreeHandle
  /** Worktree diff baseline captured before the agent edits. */
  snapshotRef: string
  members: GroupMember[]
}

interface ActiveWorkflow {
  groups: RepoGroup[]
  branch: string
  feature: string
  /** Absolute path of the canonical feature config edited in place. */
  configPath: string
  originalConfig: string | null
  /** Canonical featureDir diff baseline for the config edit. */
  configSnapshotRef: string
  abort: () => void
}

export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

export function createPortifyRunner(deps: PortifyRunnerDeps) {
  const active = new Map<string, ActiveWorkflow>()
  const healthDeadlineMs = deps.healthDeadlineMs ?? 60000

  async function startPortify(input: StartPortifyInput): Promise<StartPortifyResult> {
    if (active.size > 0) {
      throw Object.assign(
        new Error('A port-ification workflow is already running — finish or cancel it first.'),
        { statusCode: 409 },
      )
    }
    const feature = deps.loadFeatures().find((f) => f.name === input.feature)
    if (!feature) throw Object.assign(new Error(`feature not found: ${input.feature}`), { statusCode: 404 })

    const repos: RepoPrerequisite[] = feature.repos ?? []
    if (repos.length === 0) throw Object.assign(new Error(`feature "${feature.name}" declares no repos`), { statusCode: 409 })

    const agent = deps.pickAgent(input.agent)
    if (!agent) {
      const want = input.agent ? `the ${input.agent} CLI` : 'a claude/codex CLI'
      throw Object.assign(new Error(`${want} is not available`), { statusCode: 409 })
    }

    // Validate each repo is a clean git working tree and resolve its git root.
    // Worktrees only see committed files, so a dirty tree would benchmark a
    // stale snapshot — refuse with a clear error (mirrors the benchmark guard).
    const byRoot = new Map<string, GroupMember[]>()
    for (const repo of repos) {
      const repoPath = resolveRepoPath(repo.localPath)
      const status = await runGit(repoPath, ['status', '--porcelain', '--', '.'])
      if (status.code !== 0) {
        throw Object.assign(new Error(`repo "${repo.name}" at ${repo.localPath} is not a git repository`), { statusCode: 409 })
      }
      if (status.stdout.trim()) {
        throw Object.assign(
          new Error(`repo "${repo.name}" has uncommitted changes — commit or stash them first (worktrees only see committed files)`),
          { statusCode: 409 },
        )
      }
      // `git status` above returned 0, so this path IS inside a work tree —
      // rev-parse --show-toplevel resolves the root.
      const sourceRoot = (await getGitRoot(repoPath))!
      const members = byRoot.get(sourceRoot) ?? []
      members.push({ name: repo.name, path: repo.localPath })
      byRoot.set(sourceRoot, members)
    }
    // Group repos that share a git root into ONE worktree (git can't check out
    // the same branch in two worktrees of one repo).
    const groups: RepoGroup[] = [...byRoot.entries()].map(([sourceRoot, members], i) => ({
      key: `g${i}-${safeKey(path.basename(sourceRoot))}`,
      sourceRoot,
      snapshotRef: 'HEAD',
      members,
    }))

    const workflowId = `portify-${generateRunId()}`
    const dir = portifyDir(deps.logsDir, workflowId)
    const paths = buildPortifyPaths(dir)
    fs.mkdirSync(paths.verifyLogDir, { recursive: true })
    const branch = portifyBranchName(feature.name)
    const env = feature.envs?.[0]
    const configPath = path.join(feature.featureDir, 'feature.config.cjs')
    const originalConfig = readFileOrNull(configPath)
    // Persist the pre-edit config to disk so a startup reclaim can restore it
    // after a crash (the in-memory copy dies with the process).
    if (originalConfig != null) {
      try { fs.writeFileSync(paths.originalConfigPath, originalConfig) } catch { /* best-effort */ }
    }

    const manifest: PortifyManifest = {
      workflowId,
      feature: feature.name,
      featureDir: feature.featureDir,
      repos: repos.map((r) => ({ name: r.name, path: r.localPath })),
      env,
      agent,
      branch,
      status: 'planning',
      attempt: 0,
      maxAttempts: input.maxAttempts && input.maxAttempts > 0 ? input.maxAttempts : 3,
      startedAt: deps.now(),
    }
    deps.store.save(manifest)

    let aborted = false
    const children = new Set<ChildProcess>()
    const sessionId = agent === 'claude' ? randomUUID() : undefined
    const state: ActiveWorkflow = {
      groups,
      branch,
      feature: feature.name,
      configPath,
      originalConfig,
      configSnapshotRef: 'HEAD',
      abort: () => {
        aborted = true
        for (const c of children) { try { c.kill('SIGTERM') } catch { /* gone */ } }
      },
    }
    active.set(workflowId, state)

    const allMembers = (): GroupMember[] => state.groups.flatMap((g) => g.members)

    const orchestrator = new PortifyOrchestrator({
      manifest,
      persist: (m) => deps.store.save(m),
      now: deps.now,
      isAborted: () => aborted,

      setup: async () => {
        const states: PortifyRepoState[] = []
        for (const group of state.groups) {
          const wt = await createBranchAndWorktree({
            repoName: group.key,
            localPath: group.sourceRoot,
            worktreesDir: path.join(dir, 'worktrees'),
            branch,
          })
          group.handle = wt.handle
          group.snapshotRef = wt.snapshotRef
          for (const member of group.members) {
            const rel = path.relative(group.sourceRoot, resolveRepoPath(member.path))
            member.editPath = rel ? path.join(wt.handle.worktreeRoot, rel) : wt.handle.worktreeRoot
            states.push({ name: member.name, path: member.path, worktreePath: wt.handle.worktreeRoot, baseSha: wt.baseSha })
          }
        }
        // Baseline the canonical config (edited in place) before the agent runs.
        state.configSnapshotRef = (await snapshotWorkingTree(feature.featureDir)) ?? 'HEAD'
        return states
      },

      runAgent: async (attempt, failureDetail) => {
        // setup() ran (and fully succeeded) before any runAgent, so every
        // member has an editPath and every group a handle.
        const targets: RepoEditTarget[] = allMembers().map((m) => ({ name: m.name, editPath: m.editPath! }))
        const cwd = state.groups[0].handle!.worktreeRoot
        if (sessionId) writePortifyClaudeRef(dir, cwd, sessionId)
        const prompt = attempt === 1 || !failureDetail
          ? buildPortifyPrompt(feature, targets)
          : buildPortifyRetryPrompt(feature, failureDetail)
        await runPortifyAgent({
          agent, prompt, cwd, logPath: paths.agentLogPath, children, sessionId,
          resume: attempt > 1,
        })
      },

      captureDiff: async () => {
        const blocks: string[] = []
        for (const group of state.groups) {
          const d = await captureDiff(group.handle!.worktreeRoot, group.snapshotRef)
          if (d) blocks.push(`# repo: ${group.members.map((m) => m.name).join(', ')}\n${d}`)
        }
        const configDiff = await canonicalConfigDiff(feature.featureDir, state.configSnapshotRef)
        if (configDiff) blocks.push(`# feature config: ${feature.featureDir}\n${configDiff}`)
        return blocks.join('\n\n')
      },

      verify: async () => {
        // Reload the config so the agent's edits (declared slots, tokenized
        // health checks) are reflected. Source comes from each worktree.
        const fresh = deps.loadFeatures().find((f) => f.name === feature.name) ?? feature
        const overrides: Record<string, string> = {}
        for (const member of allMembers()) overrides[member.name] = member.editPath!
        return verifyDoubleBoot(fresh, env, overrides, {
          ptyFactory: deps.ptyFactory,
          healthCheck: deps.healthCheck,
          healthPollIntervalMs: deps.healthPollIntervalMs,
          healthDeadlineMs,
          verifyLogDir: paths.verifyLogDir,
        })
      },

      checkTestsUntouched: async () => {
        const offending: string[] = []
        for (const group of state.groups) {
          const changed = await changedFiles(group.handle!.worktreeRoot, group.snapshotRef)
          offending.push(...changed.filter((f) => /(^|\/)e2e\//.test(f) || /\.spec\.[tj]s$/.test(f)).map((f) => `${group.key}:${f}`))
        }
        return { ok: offending.length === 0, offending }
      },

      cleanup: async () => {
        // Reached only on failed/aborted: discard every worktree + branch and
        // restore the canonical config we edited in place.
        for (const group of state.groups) {
          if (group.handle) await discardWorktree(group.handle, branch)
        }
        restoreConfig(state)
        active.delete(workflowId)
      },
    })

    // Fire-and-forget; the UI polls the manifest. orchestrator.run() handles all
    // its own errors internally (persisting 'failed' + cleanup), so it never
    // rejects — `void` marks the intentional float.
    void orchestrator.run()

    return { workflowId }
  }

  async function commit(workflowId: string): Promise<PortifyManifest> {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    if (m.status !== 'ready-to-commit') {
      throw Object.assign(new Error(`cannot commit a workflow in status "${m.status}"`), { statusCode: 409 })
    }
    const state = active.get(workflowId)
    if (!state) throw Object.assign(new Error('worktree is no longer available'), { statusCode: 409 })

    const message = `feat: make ${m.feature} ports injectable for concurrent boot`
    const shaByMember = new Map<string, string | undefined>()
    for (const group of state.groups) {
      // Reaching commit means setup fully succeeded → every group has a handle.
      const sha = await commitWorktree(group.handle!.worktreeRoot, message)
      if (sha) {
        // Keep the branch (with the commit); free the worktree checkout.
        // removeWorktree drops the checkout but NOT the branch ref.
        await removeWorktree(group.handle!)
      } else {
        // No source change in this group — drop the empty branch + worktree.
        await discardWorktree(group.handle!, state.branch)
      }
      for (const member of group.members) shaByMember.set(member.name, sha ?? undefined)
    }
    active.delete(workflowId)
    const repoStates: PortifyRepoState[] = m.repos.map((r) => {
      const sha = shaByMember.get(r.name)
      return sha ? { ...r, commitSha: sha } : r
    })
    const next: PortifyManifest = { ...m, repos: repoStates, status: 'committed', endedAt: deps.now() }
    deps.store.save(next)
    return next
  }

  async function cancel(workflowId: string): Promise<PortifyManifest> {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    const state = active.get(workflowId)
    if (state) {
      state.abort()
      for (const group of state.groups) {
        if (group.handle) await discardWorktree(group.handle, state.branch)
      }
      restoreConfig(state)
      active.delete(workflowId)
    }
    if (m.status === 'committed') return m
    const next: PortifyManifest = { ...m, status: 'aborted', endedAt: m.endedAt ?? deps.now() }
    deps.store.save(next)
    return next
  }

  return { startPortify, commit, cancel, abort: cancel }
}

function readFileOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

function restoreConfig(state: ActiveWorkflow): void {
  if (state.originalConfig == null) return
  try { fs.writeFileSync(state.configPath, state.originalConfig) } catch { /* best-effort */ }
}

// Diff of the canonical feature config edited in place (a different git root
// than the product repo for external features). Empty when not a git repo.
async function canonicalConfigDiff(featureDir: string, ref: string): Promise<string> {
  const res = await runGit(featureDir, ['diff', ref, '--', 'feature.config.cjs'])
  return res.code === 0 ? res.stdout : ''
}
