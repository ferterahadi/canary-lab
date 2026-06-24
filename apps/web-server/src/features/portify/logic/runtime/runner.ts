import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { type ChildProcess } from 'child_process'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../../../shared/launcher/types'
import { runGit, resolveRepoPath, snapshotWorkingTree, getGitRoot } from '../../../../shared/git-repo'
import type { PtyFactory } from '../../../runs/logic/runtime/pty-spawner'
import type { HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { generateRunId } from '../../../runs/logic/runtime/run-id'
import { type WorktreeHandle } from '../../../runs/logic/runtime/repo-worktree'
import { PortifyRunStore } from './store'
import { PortifyOrchestrator } from './orchestrator'
import { buildPortifyPaths, portifyDir } from './paths'
import { createBranchAndWorktree, captureDiff, changedFiles, discardWorktree, portifyBranchName, applyOverlay, resetWorktree } from './git-ops'
import { writeOverlay, readOverlay, captureTouchedFiles, type OverlayRepoInput } from './overlay'
import { runPortifyAgent, writePortifyClaudeRef } from './agent'
import { buildPortifyPrompt, buildPortifyRetryPrompt, buildPortifyFeedbackPrompt, type RepoEditTarget } from './prompt'
import { verifyDoubleBoot } from './verify'
import type {
  PortifyManifest,
  PortifyRepoState,
  PortifyProducer,
  PortifyExternalSession,
  StartPortifyInput,
  StartPortifyResult,
  StartExternalPortifyInput,
  StartExternalPortifyResult,
  ExternalPortifyEditTarget,
} from './types'

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
  /** Sibling overlays pre-applied into the scratch worktree(s) at setup, so the
   *  agent/client doesn't redo a rewrite the same app already received. Surfaced
   *  in the prompt + external instructions; the borrowed lines also flow into
   *  this feature's own captured diff/overlay (self-contained, no dependency). */
  seededFrom: { feature: string; repos: string[] }[]
  /** Set once the orchestrator is constructed; drives user-feedback revise passes. */
  orchestrator?: PortifyOrchestrator
}

export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

/** A reusable port patch another feature already saved for the same git root. */
interface BorrowCandidate {
  /** The sibling feature whose overlay this came from. */
  feature: string
  /** Unified diff content to pre-apply into the scratch worktree. */
  patch: string
  /** HEAD the sibling captured the patch against (prefer an exact match). */
  baseSha: string
  /** ISO capture time — newest wins when several siblings match. */
  capturedAt: string
}

/**
 * Index every OTHER feature's saved overlay by the git root its patch targets,
 * so a new port-ification can borrow an existing rewrite for the same app
 * instead of redoing it. Skips empty (source-native) overlays — there's nothing
 * to apply. Resolving a sibling repo's git root requires the same path dance as
 * setup (resolveRepoPath → getGitRoot).
 */
async function buildSiblingOverlayIndex(
  features: FeatureConfig[],
  currentFeature: string,
): Promise<Map<string, BorrowCandidate[]>> {
  const index = new Map<string, BorrowCandidate[]>()
  for (const f of features) {
    if (f.name === currentFeature) continue
    const overlay = readOverlay(f.featureDir)
    if (!overlay) continue
    for (const repo of overlay.meta.repos) {
      const patch = overlay.patches[repo.name]
      if (!patch || !patch.trim()) continue // source-native overlay — nothing to borrow
      const decl = (f.repos ?? []).find((r) => r.name === repo.name)
      if (!decl) continue
      let root: string | null = null
      try { root = await getGitRoot(resolveRepoPath(decl.localPath)) } catch { /* unresolved repo — skip */ }
      if (!root) continue
      const list = index.get(root) ?? []
      list.push({ feature: f.name, patch, baseSha: repo.baseSha, capturedAt: overlay.meta.capturedAt })
      index.set(root, list)
    }
  }
  return index
}

/**
 * Note for the agent/client when sibling overlays were pre-applied to the
 * worktree — so it reviews the existing edits + declares config slots instead
 * of rewriting from scratch (and isn't surprised by a populated tree).
 */
export function buildSeededNote(seededFrom: { feature: string; repos: string[] }[]): string | undefined {
  if (seededFrom.length === 0) return undefined
  const from = seededFrom.map((s) => `"${s.feature}" (${s.repos.join(', ')})`).join('; ')
  return `NOTE: the same app was already port-ified for another feature, so its port-injection patch from ${from} has been PRE-APPLIED to the worktree source — the listeners likely already read injected ports. Review the existing edits; you may only need to declare the matching \`ports\` slots in the feature config. A no-op source change is fine — the concurrent double-boot is what proves it.`
}

/** Pick the best sibling patch for a root: exact base-SHA match first, then newest. */
function pickBorrowable(candidates: BorrowCandidate[] | undefined, baseSha: string): BorrowCandidate | null {
  if (!candidates || candidates.length === 0) return null
  return [...candidates].sort(
    (a, b) =>
      Number(b.baseSha === baseSha) - Number(a.baseSha === baseSha) ||
      b.capturedAt.localeCompare(a.capturedAt),
  )[0]
}

export function createPortifyRunner(deps: PortifyRunnerDeps) {
  const active = new Map<string, ActiveWorkflow>()
  const healthDeadlineMs = deps.healthDeadlineMs ?? 60000

  // Validate + set up a workflow (git checks, scratch worktrees, manifest, the
  // orchestrator + its injected I/O) and register it in `active`. Shared by the
  // local path (which then run()s the agent) and the external path (which parks
  // at `editing` for the user's own client to edit the worktree in place). The
  // caller resolves the feature + agent; this returns the live orchestrator so
  // the caller decides run() vs startExternal().
  async function prepareWorkflow(
    feature: FeatureConfig,
    agent: HealAgent,
    opts: { maxAttempts?: number; producer: PortifyProducer; external?: PortifyExternalSession },
  ): Promise<{ workflowId: string; state: ActiveWorkflow; orchestrator: PortifyOrchestrator }> {
    const repos: RepoPrerequisite[] = feature.repos ?? []
    if (repos.length === 0) throw Object.assign(new Error(`feature "${feature.name}" declares no repos`), { statusCode: 409 })

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
      producer: opts.producer,
      ...(opts.external ? { external: opts.external } : {}),
      branch,
      status: 'planning',
      attempt: 0,
      maxAttempts: opts.maxAttempts && opts.maxAttempts > 0 ? opts.maxAttempts : 3,
      feedbackRounds: 0,
      startedAt: deps.now(),
    }
    deps.store.save(manifest)

    let aborted = false
    const children = new Set<ChildProcess>()
    // External edits happen in the user's own client — no local session to pin.
    const sessionId = opts.producer === 'internal' && agent === 'claude' ? randomUUID() : undefined
    const state: ActiveWorkflow = {
      groups,
      branch,
      feature: feature.name,
      configPath,
      originalConfig,
      configSnapshotRef: 'HEAD',
      seededFrom: [],
      abort: () => {
        aborted = true
        for (const c of children) { try { c.kill('SIGTERM') } catch { /* gone */ } }
      },
    }
    active.set(workflowId, state)

    const allMembers = (): GroupMember[] => state.groups.flatMap((g) => g.members)

    // Run the agent in the first group's worktree with a given prompt. `resume`
    // continues the pinned claude session (no-op for codex, which re-execs).
    const runAgentWithPrompt = async (prompt: string, resume: boolean): Promise<void> => {
      const cwd = state.groups[0].handle!.worktreeRoot
      if (sessionId) writePortifyClaudeRef(dir, cwd, sessionId)
      await runPortifyAgent({ agent, prompt, cwd, logPath: paths.agentLogPath, children, sessionId, resume })
    }

    const orchestrator = new PortifyOrchestrator({
      manifest,
      persist: (m) => deps.store.save(m),
      now: deps.now,
      isAborted: () => aborted,

      setup: async () => {
        const states: PortifyRepoState[] = []
        // Borrow: if another feature already saved a port overlay for the same
        // app (git root), pre-apply it so this workflow starts from the existing
        // rewrite instead of redoing it. Built once; matched per group below.
        const siblingOverlays = await buildSiblingOverlayIndex(deps.loadFeatures(), feature.name)
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
            // `group.sourceRoot` is symlink-resolved (git rev-parse --show-toplevel),
            // so resolve the member path the same way before diffing — otherwise a
            // symlinked ancestor (e.g. macOS /var → /private/var) makes path.relative
            // emit a bogus `../..` traversal and editPath points outside the worktree.
            const rel = path.relative(group.sourceRoot, realpathOrSelf(resolveRepoPath(member.path)))
            member.editPath = rel ? path.join(wt.handle.worktreeRoot, rel) : wt.handle.worktreeRoot
            states.push({ name: member.name, path: member.path, worktreePath: wt.handle.worktreeRoot, baseSha: wt.baseSha })
          }
          // Apply the borrowed patch AFTER snapshotRef is captured, so the
          // borrowed lines land in this feature's own captured diff/overlay
          // (self-contained). Borrowing is an optimization — never fatal.
          const borrowed = pickBorrowable(siblingOverlays.get(group.sourceRoot), wt.baseSha)
          if (borrowed) {
            const seedPatch = path.join(dir, `seed-${group.key}.patch`)
            try {
              fs.writeFileSync(seedPatch, borrowed.patch)
              const outcome = await applyOverlay(wt.handle.worktreeRoot, seedPatch)
              if (outcome.kind === 'ok') {
                state.seededFrom.push({ feature: borrowed.feature, repos: group.members.map((m) => m.name) })
              } else {
                // A conflict/error means we couldn't cleanly seed (base drift,
                // overlapping edits). `--3way` leaves conflict markers in the
                // files even on failure, so scrub the worktree back to a clean
                // HEAD before the agent edits from scratch — otherwise the
                // markers poison its edits and the captured diff.
                await resetWorktree(wt.handle.worktreeRoot)
              }
            } catch { /* best-effort seed */ }
            finally { try { fs.rmSync(seedPatch, { force: true }) } catch { /* gone */ } }
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
        const prompt = attempt === 1 || !failureDetail
          ? buildPortifyPrompt(feature, targets, buildSeededNote(state.seededFrom))
          : buildPortifyRetryPrompt(feature, failureDetail)
        await runAgentWithPrompt(prompt, attempt > 1)
      },

      // Revise pass: resume the session (claude) with the human's feedback.
      // Codex has no --resume, so it re-execs against the already-edited
      // worktree — context-light but it still sees and adjusts its prior work.
      runFeedbackAgent: async (feedback) => {
        await runAgentWithPrompt(buildPortifyFeedbackPrompt(feature, feedback), true)
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

    state.orchestrator = orchestrator
    return { workflowId, state, orchestrator }
  }

  async function startPortify(input: StartPortifyInput): Promise<StartPortifyResult> {
    if (active.size > 0) {
      throw Object.assign(
        new Error('A port-ification workflow is already running — finish or cancel it first.'),
        { statusCode: 409 },
      )
    }
    const feature = deps.loadFeatures().find((f) => f.name === input.feature)
    if (!feature) throw Object.assign(new Error(`feature not found: ${input.feature}`), { statusCode: 404 })
    const agent = deps.pickAgent(input.agent)
    if (!agent) {
      const want = input.agent ? `the ${input.agent} CLI` : 'a claude/codex CLI'
      throw Object.assign(new Error(`${want} is not available`), { statusCode: 409 })
    }
    const { workflowId, orchestrator } = await prepareWorkflow(feature, agent, {
      maxAttempts: input.maxAttempts,
      producer: 'internal',
    })
    // Fire-and-forget; the UI polls the manifest. orchestrator.run() handles all
    // its own errors internally (persisting 'failed' + cleanup), so it never
    // rejects — `void` marks the intentional float.
    void orchestrator.run()
    return { workflowId }
  }

  // External producer: the port-ification agent runs in the user's OWN Claude/
  // Codex client (via MCP) and edits the scratch worktree IN PLACE. We set the
  // worktree up, park at `editing`, and hand the client the edit paths + the
  // task prompt; the app process never spawns an agent. Mirrors external
  // heal/wizard/eval. submitExternalPortify drives verification afterwards.
  async function startExternalPortify(input: StartExternalPortifyInput): Promise<StartExternalPortifyResult> {
    if (active.size > 0) {
      throw Object.assign(
        new Error('A port-ification workflow is already running — finish or cancel it first.'),
        { statusCode: 409 },
      )
    }
    const feature = deps.loadFeatures().find((f) => f.name === input.feature)
    if (!feature) throw Object.assign(new Error(`feature not found: ${input.feature}`), { statusCode: 404 })
    // The client doing the edits IS a claude or codex session — record which so
    // the saved overlay's audit reflects the producer.
    const agent: HealAgent = input.clientKind.startsWith('codex') ? 'codex' : 'claude'
    const external: PortifyExternalSession = {
      clientKind: input.clientKind,
      sessionId: input.sessionId,
      ...(input.conversationName ? { conversationName: input.conversationName } : {}),
      ...(input.sessionUrl ? { sessionUrl: input.sessionUrl } : {}),
    }
    const { workflowId, state, orchestrator } = await prepareWorkflow(feature, agent, {
      maxAttempts: 1,
      producer: 'external',
      external,
    })
    const m = await orchestrator.startExternal()
    if (m.status !== 'editing') {
      throw Object.assign(
        new Error(m.error ?? 'failed to set up the external port-ification worktree'),
        { statusCode: 409 },
      )
    }
    const targets: ExternalPortifyEditTarget[] = state.groups
      .flatMap((g) => g.members)
      .map((member) => ({ name: member.name, editPath: member.editPath! }))
    return {
      workflowId,
      targets,
      configPath: path.join(feature.featureDir, 'feature.config.cjs'),
      instructions: buildPortifyPrompt(feature, targets.map((t) => ({ name: t.name, editPath: t.editPath })), buildSeededNote(state.seededFrom)),
    }
  }

  // External producer: verify the edits the client made in place, then park at
  // ready-to-save (pass) or back at editing (fail, so the client can fix +
  // resubmit). Fire-and-forget like the local run/revise — the client polls
  // get_portify. Returns the manifest as it stood when submit was accepted.
  async function submitExternalPortify(workflowId: string): Promise<PortifyManifest> {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    if (m.producer !== 'external') {
      throw Object.assign(new Error('not an external port-ification workflow'), { statusCode: 409 })
    }
    if (m.status !== 'editing') {
      throw Object.assign(new Error(`cannot submit a workflow in status "${m.status}"`), { statusCode: 409 })
    }
    const state = active.get(workflowId)
    if (!state?.orchestrator) {
      throw Object.assign(
        new Error('worktree is no longer available — the server may have restarted; start a new workflow'),
        { statusCode: 409 },
      )
    }
    void state.orchestrator.verifyExternalEdits(m)
    return deps.store.get(workflowId) ?? m
  }

  // User-driven revise pass from the review screen: resume the agent with the
  // human's feedback, re-verify, and re-park at ready-to-save. Fire-and-forget
  // like the initial run — the UI polls the manifest as it cycles back through
  // editing → verifying → ready-to-save. Returns the manifest in its
  // just-flipped `editing` state so the caller gets immediate feedback.
  async function revise(workflowId: string, feedback: string): Promise<PortifyManifest> {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    if (m.status !== 'ready-to-save') {
      throw Object.assign(new Error(`cannot revise a workflow in status "${m.status}"`), { statusCode: 409 })
    }
    const trimmed = feedback.trim()
    if (!trimmed) throw Object.assign(new Error('feedback is required'), { statusCode: 400 })
    const state = active.get(workflowId)
    if (!state?.orchestrator) {
      throw Object.assign(
        new Error('worktree is no longer available — the server may have restarted; start a new workflow'),
        { statusCode: 409 },
      )
    }
    // Float the pass; the orchestrator persists every transition and never
    // rejects (it re-parks at ready-to-save even on error).
    void state.orchestrator.revise(m, trimmed)
    return deps.store.get(workflowId) ?? m
  }

  /**
   * Ephemeral-overlay terminal action (replaces commit/merge). Captures the
   * agent's verified edits as a unified diff per git-root group and writes them
   * as the feature's saved overlay under `features/<feature>/portify/`. The
   * scratch worktree + branch are then discarded — unlike commit, NOTHING lands
   * in the product repo's history. At run time the overlay is `git apply`-ed
   * into a fresh per-run worktree and reverse-applied at teardown (see the
   * RunOrchestrator).
   */
  async function save(workflowId: string): Promise<PortifyManifest> {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    // Idempotent: if already saved (e.g. a double-save race), return as-is.
    if (m.status === 'saved') return m
    if (m.status !== 'ready-to-save') {
      throw Object.assign(new Error(`cannot save a workflow in status "${m.status}"`), { statusCode: 409 })
    }
    if (m.verification && !m.verification.ok) {
      throw Object.assign(
        new Error('the latest changes did not pass verification — give more feedback or cancel'),
        { statusCode: 409 },
      )
    }
    const state = active.get(workflowId)
    if (!state) throw Object.assign(new Error('worktree is no longer available'), { statusCode: 409 })

    // One captured diff per git-root group; every member repo in the group
    // shares that group's worktree (so the same patch + base SHA). Run time
    // forces one worktree per repo NAME and applies the repo's patch into it.
    const overlayRepos: OverlayRepoInput[] = []
    for (const group of state.groups) {
      const wt = group.handle! // reaching save means setup fully succeeded
      const patch = await captureDiff(wt.worktreeRoot, group.snapshotRef)
      const baseSha = (await runGit(wt.worktreeRoot, ['rev-parse', 'HEAD'])).stdout.trim()
      const changed = await changedFiles(wt.worktreeRoot, group.snapshotRef)
      const touchedFiles = await captureTouchedFiles(wt.worktreeRoot, baseSha, changed)
      for (const member of group.members) {
        overlayRepos.push({ name: member.name, baseSha, patch, touchedFiles })
      }
    }
    writeOverlay(m.featureDir, {
      featureName: m.feature,
      agent: m.agent,
      capturedAt: deps.now(),
      repos: overlayRepos,
    })

    // The scratch worktree + branch have served their purpose (the diff is
    // captured) — discard them so nothing lingers in the product repo.
    for (const group of state.groups) {
      await discardWorktree(group.handle!, state.branch)
    }
    active.delete(workflowId)
    const next: PortifyManifest = { ...m, status: 'saved', endedAt: deps.now() }
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
    // A finished (saved) workflow is returned untouched.
    if (m.status === 'saved') return m
    const next: PortifyManifest = { ...m, status: 'aborted', endedAt: m.endedAt ?? deps.now() }
    deps.store.save(next)
    return next
  }

  // Remove a finished workflow from history (index + run dir). Only terminal
  // workflows can be removed — an active one must be saved or cancelled first.
  async function remove(workflowId: string): Promise<{ workflowId: string; removed: true }> {
    // Fall back to the index row's status when the record file is gone: an
    // orphaned row (record wiped out-of-band) must still be removable from
    // history — otherwise a zombie row can never be cleared (store.remove is
    // tolerant; only this guard 404'd it). The index keeps the status.
    const m = deps.store.get(workflowId)
    const status = m?.status ?? deps.store.list().find((e) => e.workflowId === workflowId)?.status
    if (!status) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    const terminal = status === 'saved' || status === 'failed' || status === 'aborted'
    if (!terminal) {
      throw Object.assign(
        new Error(`cannot remove a workflow in status "${status}" — save or cancel it first`),
        { statusCode: 409 },
      )
    }
    deps.store.remove(workflowId)
    return { workflowId, removed: true }
  }

  return { startPortify, startExternalPortify, submitExternalPortify, save, cancel, revise, remove, abort: cancel }
}

function readFileOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
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
