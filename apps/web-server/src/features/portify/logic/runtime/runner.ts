import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { PtyFactory } from '../../../runs/logic/runtime/pty-spawner'
import type { HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { prepareWorkflow as prepare } from './prepare-workflow'
import { PortifyRunStore } from './store'
import { PortifyOrchestrator } from './orchestrator'
import { buildPortifyPaths, portifyDir } from './paths'
import { discardWorktree } from './git-ops'
import { writeOverlay } from './overlay'
import { buildPortifyPrompt, buildPortifyFeedbackPrompt, buildPortifyRetryPrompt } from './prompt'
import type { PortifyManifest, PortifyProducer, PortifyExternalSession, StartPortifyInput, StartPortifyResult, StartExternalPortifyInput, StartExternalPortifyResult, ExternalPortifyEditTarget } from './types'
import { captureOverlayRepos, readPendingOverlay, restoreConfig } from './portify-overlay-capture'
import { RepoGroup, buildSeededNote, portifyConcurrencyCap } from './portify-worktree-borrow'

export { canonicalConfigDiff, captureOverlayRepos, readFileOrNull, realpathOrSelf, restoreConfig } from './portify-overlay-capture'
export { buildSeededNote, buildSiblingOverlayIndex, pickBorrowable, portifyConcurrencyCap, safeKey } from './portify-worktree-borrow'
export type { GroupMember, RepoGroup } from './portify-worktree-borrow'

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

export interface ActiveWorkflow {
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

export function createPortifyRunner(deps: PortifyRunnerDeps) {
  const active = new Map<string, ActiveWorkflow>()
  const healthDeadlineMs = deps.healthDeadlineMs ?? 60000

  // Admission for a new workflow. One workflow PER FEATURE (a second on the same
  // feature would fight over its featureDir config + overlay path); different
  // features run concurrently up to the global resource cap (the double-boot
  // verify is heavy). Shared by the local + external start paths so the two
  // never drift. Throws 409 (same feature) / 429 (at capacity) with a
  // statusCode the routes + MCP tools surface verbatim.
  function admitNewWorkflow(featureName: string): void {
    if ([...active.values()].some((w) => w.feature === featureName)) {
      throw Object.assign(
        new Error(`A port-ification workflow is already running for "${featureName}" — finish or cancel it first.`),
        { statusCode: 409 },
      )
    }
    // A review parked across a server restart is still answerable (reclaim kept
    // it, save works from its persisted capture) and still owns the feature's
    // in-place config edit — a second workflow would snapshot that PORTIFIED
    // config as its "original" and corrupt the revert chain.
    if (deps.store.list().some((e) => e.feature === featureName && e.status === 'ready-to-save' && !active.has(e.workflowId))) {
      throw Object.assign(
        new Error(`A verified port-ification review for "${featureName}" is parked awaiting save/cancel — answer it (or cancel it) first.`),
        { statusCode: 409 },
      )
    }
    const cap = portifyConcurrencyCap()
    if (active.size >= cap) {
      throw Object.assign(
        new Error(`At port-ification capacity (${active.size}/${cap} active) — wait for one to finish, or save/cancel an active workflow before starting another feature.`),
        { statusCode: 429 },
      )
    }
  }

  // Setup lives in ./prepare-workflow — it was a 280-line closure here.
  const prepareWorkflow = (
    feature: FeatureConfig,
    agent: HealAgent,
    opts: { maxAttempts?: number; producer: PortifyProducer; external?: PortifyExternalSession },
  ) => prepare({ deps, active, healthDeadlineMs }, feature, agent, opts)

  async function startPortify(input: StartPortifyInput): Promise<StartPortifyResult> {
    admitNewWorkflow(input.feature)
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
    admitNewWorkflow(input.feature)
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

  // External twin of revise(): the human wants a change to a diff that already
  // passed the double-boot. Canary spawns nothing — it reopens the workflow so
  // the client keeps editing the SAME worktree, and hands back the feedback
  // prompt because the constraints have to be restated (don't touch tests, don't
  // commit, envsets stay token-driven, the double-boot runs again). Synchronous:
  // unlike the internal revise there is no agent pass to float, so the caller
  // gets the reopened manifest itself rather than a status to poll.
  function reviseExternalPortify(workflowId: string, feedback: string): { manifest: PortifyManifest; instructions: string } {
    const m = deps.store.get(workflowId)
    if (!m) throw Object.assign(new Error('workflow not found'), { statusCode: 404 })
    if (m.producer !== 'external') {
      throw Object.assign(new Error('not an external port-ification workflow'), { statusCode: 409 })
    }
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
    const feature = deps.loadFeatures().find((f) => f.name === m.feature)
    if (!feature) throw Object.assign(new Error(`feature not found: ${m.feature}`), { statusCode: 404 })
    return {
      manifest: state.orchestrator.reopenExternal(m),
      instructions: buildPortifyFeedbackPrompt(feature, trimmed),
    }
  }

  // The retry playbook for a failed double-boot, rendered for an EXTERNAL client.
  // The internal agent gets this automatically on its next attempt; without it the
  // client sees only the raw failureDetail and none of its reading — the
  // baseline-vs-concurrency verdict split, the non-HTTP listener hunt, the shared
  // build-cache race. Returns null when there is no recorded failure to explain.
  function externalRetryPrompt(workflowId: string): string | null {
    const m = deps.store.get(workflowId)
    if (!m || m.producer !== 'external') return null
    if (m.status !== 'editing' || m.verification?.ok !== false) return null
    const feature = deps.loadFeatures().find((f) => f.name === m.feature)
    if (!feature) return null
    return buildPortifyRetryPrompt(feature, m.verification.failureDetail ?? '(no detail recorded)')
  }

  function dropPendingOverlay(workflowId: string): void {
    const paths = buildPortifyPaths(portifyDir(deps.logsDir, workflowId))
    try { fs.rmSync(paths.pendingOverlayPath, { force: true }) } catch { /* best-effort */ }
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
    if (!state) {
      // Server restarted since verification: the worktrees are gone, but the
      // ready-to-save park persisted its overlay capture (pending-overlay.json)
      // and startup reclaim deliberately left the workflow parked. Save from
      // the capture — the diff it holds is exactly the last VERIFIED state.
      const paths = buildPortifyPaths(portifyDir(deps.logsDir, workflowId))
      const pending = readPendingOverlay(paths.pendingOverlayPath)
      if (!pending) throw Object.assign(new Error('worktree is no longer available'), { statusCode: 409 })
      writeOverlay(m.featureDir, {
        featureName: m.feature,
        agent: m.agent,
        capturedAt: deps.now(),
        repos: pending.repos,
        originalConfig: pending.originalConfig,
      })
      try { fs.rmSync(paths.pendingOverlayPath, { force: true }) } catch { /* best-effort */ }
      const next: PortifyManifest = { ...m, status: 'saved', endedAt: deps.now() }
      deps.store.save(next)
      return next
    }

    const overlayRepos = await captureOverlayRepos(state)
    writeOverlay(m.featureDir, {
      featureName: m.feature,
      agent: m.agent,
      capturedAt: deps.now(),
      repos: overlayRepos,
      // The pre-edit feature config, so "Remove portification" can revert the
      // slots + ${port.x} health-check rewrites, not just delete the overlay.
      originalConfig: state.originalConfig,
    })

    // The scratch worktree + branch have served their purpose (the diff is
    // captured) — discard them so nothing lingers in the product repo.
    for (const group of state.groups) {
      await discardWorktree(group.handle!, state.branch)
    }
    active.delete(workflowId)
    dropPendingOverlay(workflowId)
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
    } else if (m.status === 'ready-to-save') {
      // A review parked across a server restart (reclaim kept it answerable and
      // deliberately did NOT restore the config — the feature stays portified
      // in place exactly as while parked live). Declining must undo that edit:
      // restore from the on-disk snapshot the start persisted.
      const paths = buildPortifyPaths(portifyDir(deps.logsDir, workflowId))
      try {
        if (fs.existsSync(paths.originalConfigPath)) {
          fs.writeFileSync(path.join(m.featureDir, 'feature.config.cjs'), fs.readFileSync(paths.originalConfigPath, 'utf-8'))
        }
      } catch { /* best-effort */ }
    }
    dropPendingOverlay(workflowId)
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

  return { startPortify, startExternalPortify, submitExternalPortify, reviseExternalPortify, externalRetryPrompt, save, cancel, revise, remove, abort: cancel }
}
