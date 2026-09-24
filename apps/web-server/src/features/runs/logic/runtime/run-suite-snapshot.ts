// The run-start suite snapshot (D9). Canary Lab's verdict must stay outside the
// agent's control, and the cheapest way an agent turns a run green is to edit
// the spec while the run is live. Detection (`dirty-specs`) only *notices*
// that; this module makes it inert: `features/<suite>/` is copied under the run
// dir before any service or agent starts, Playwright runs from the copy, and
// every verdict reader lists specs in the copy (`RunContext.suiteDir`). A
// mid-run edit changes nothing the run executes until a human adopts it, which
// re-takes this snapshot.
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RunContext } from './run-context'
import { copyDirRecursive } from '../../../../../../../shared/lib/copy-dir'
import { computePendingEdits, hashFeatureSpecs } from '../dirty-specs/detect'
import { readManifest, type RunManifest, type SpecEditsAdoptedBy } from './manifest'
import { captureDirtySpecBaseline } from './run-manifest-writer'
import { INTEGRITY_HINT_DISCLOSURE, deriveIntegrityHints } from './run-integrity-hints'
import { detectHealMode } from './auto-heal'
import { buildSuiteReview, skipSuiteSnapshotPath, suiteReviewRevision, suiteReviewFiles } from './suite-review'
import { saveSuiteTestRoster } from '../suite-test-roster'
import type { TestReviewDecision, TestReviewGitReceipt } from '../../../../../../../shared/test-review'
import { materializeSuiteRuntimeInputs, prepareSuiteRuntimeInputs, suiteRuntimeInputTargets, suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'

export type AdoptSpecEditsResult =
  | { ok: true; adopted: string[]; rerun: 'signalled' | 'not-waiting-for-signal' | 'signal-already-pending' }
  | { ok: false; reason: 'tests-running' | 'nothing-to-adopt' | 'snapshot-failed' | 'review-changed' }

export type RestoreSpecEditsResult =
  | { ok: true; restored: string[] }
  | { ok: false; reason: 'tests-running' | 'nothing-to-restore' | 'restore-failed' | 'review-changed' }

export type RestoreReviewedSuiteResult =
  | { ok: true; restored: string[]; revision: string }
  | { ok: false; reason: 'nothing-to-restore' | 'restore-failed' | 'review-changed' }

/** Exact-revision restoration shared by active and terminal runs. It refuses
 * every path before writing when either side traverses a symlink. */
export function restoreReviewedSuiteFiles(
  snapshotDir: string,
  liveDir: string,
  expectedRevision: string,
  excludedPaths: Iterable<string> = [],
): RestoreReviewedSuiteResult {
  const review = suiteReviewFiles(snapshotDir, liveDir, excludedPaths)
  if (review.revision !== expectedRevision) return { ok: false, reason: 'review-changed' }
  if (review.files.length === 0) return { ok: false, reason: 'nothing-to-restore' }
  const restored: string[] = []
  try {
    for (const edit of review.files) {
      for (const root of [liveDir, snapshotDir]) {
        let target = root
        for (const segment of edit.file.split('/')) {
          target = path.join(target, segment)
          try {
            if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Restore path contains a symlink')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    }
    for (const edit of review.files) {
      const liveFile = path.join(liveDir, edit.file)
      if (edit.change === 'added') fs.rmSync(liveFile)
      else {
        fs.mkdirSync(path.dirname(liveFile), { recursive: true })
        fs.copyFileSync(path.join(snapshotDir, edit.file), liveFile)
      }
      restored.push(edit.file)
    }
    return { ok: true, restored, revision: review.revision }
  } catch {
    return { ok: false, reason: 'restore-failed' }
  }
}

/** One digest over every spec's content, independent of listing order. Lets a
 *  reader check that the copy still holds what it held at run start. */
export function suiteDigest(suiteDir: string): string {
  return digestOfSpecHashes(hashFeatureSpecs(suiteDir))
}

/** The digest over an already-computed `hashFeatureSpecs` map — what
 *  `suiteDigest` records and what `verify-certificate.mjs` re-derives offline;
 *  an empty map digests too, so a run with no readable suite still gets the
 *  real digest shape. */
export function digestOfSpecHashes(hashes: Record<string, string>): string {
  const h = createHash('sha256')
  for (const rel of Object.keys(hashes).sort()) h.update(`${rel}\0${hashes[rel]}\n`)
  return h.digest('hex')
}

/** Re-measure the live suite against the copy and write the result to the
 *  manifest. Called after every Playwright exit, so the run's own record — and
 *  every MCP result derived from it — says which live edits the verdict never
 *  executed. Carries the adopted history forward; a run without a snapshot
 *  records nothing, since there is no boundary to measure against. */
export function recordSpecEdits(ctx: RunContext, decision?: TestReviewDecision): void {
  if (ctx.suiteDir === ctx.feature.featureDir) return
  const previous = readManifest(ctx.paths.manifestPath)?.specEdits
  const adopted = previous?.adopted ?? []
  const reviewDecisions = [...(previous?.reviewDecisions ?? []), ...(decision ? [decision] : [])]
  const pending = computePendingEdits(ctx.feature.featureDir, ctx.suiteDir)
  ctx.stateSink.patchManifest(ctx.runId, {
    specEdits: { checkedAt: new Date().toISOString(), pending, adopted, ...(reviewDecisions.length ? { reviewDecisions } : {}) },
    integrity: { hints: deriveIntegrityHints(pending, (rel) => readLive(ctx.feature.featureDir, rel)), disclosure: INTEGRITY_HINT_DISCLOSURE },
  })
}

/** The dirty-spec watcher saw a live spec of `feature` change. Re-measure this
 *  run's pending edits now — otherwise the run's own count sits at its last
 *  Playwright exit for as long as the run waits on a heal, and the hero, the
 *  chip and the review would offer no Restore/Adopt for an edit the feature
 *  list already shows against the run-start copy (seen live). Skipped while
 *  Playwright executes: the exit handler records then, and the count must not
 *  move under a verdict being read. Reads only; the boundary stays put. */
export function refreshSpecEdits(ctx: RunContext, feature: string): void {
  if (feature !== ctx.feature.name || ctx.playwrightPty) return
  recordSpecEdits(ctx)
}

function readLive(featureDir: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(featureDir, rel), 'utf8')
  } catch {
    return undefined // deleted since run start — the hint then carries no @req ids
  }
}

/** A human lets the live edits into this run: the snapshot is taken again from
 *  the live suite, the dirty baseline re-read from it, the adoption recorded on
 *  the manifest, and a rerun signalled so the adopted suite actually runs. The
 *  human path that moves the boundary. MCP reaches the same HTTP route only
 *  after elicitation accepts the exact reviewed revision. Refused
 *  while Playwright is executing the current copy: replacing files under a
 *  running process would corrupt the very run it is meant to inform. */
export async function adoptSpecEdits(ctx: RunContext, expectedRevision?: string, git?: TestReviewGitReceipt): Promise<AdoptSpecEditsResult> {
  if (ctx.playwrightPty) return { ok: false, reason: 'tests-running' }
  const runtimeInputs = suiteRuntimeInputTargets(ctx)
  const revision = expectedRevision ?? (ctx.suiteDir !== ctx.feature.featureDir ? suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir, runtimeInputs) : undefined)
  const adopted = await adoptPendingSpecEdits(ctx, 'human', revision, git)
  if (!adopted.ok) return adopted
  const signal = ctx.signalGate.observe('rerun', {
    hypothesis: 'A human adopted the edited spec(s) into this run.',
    fixDescription: `Adopted ${adopted.adopted.join(', ')}; rerunning the suite as it now reads.`,
    adoptedSpecEdits: adopted.adopted,
  })
  return { ok: true, adopted: adopted.adopted, rerun: signal.accepted ? 'signalled' : signal.reason }
}

/** A human puts the live suite back to what the run executed: every pending edit
 *  is undone from the run-start copy (a modified or deleted spec is rewritten
 *  from the copy, an added one removed) and the manifest re-measured, so
 *  `specEdits.pending` and the hints empty out. The other human-only lever
 *  beside adopt (D9/D13); MCP reaches it only after human elicitation for an
 *  exact revision. Nothing moves the boundary or reruns: the verdict rests on the
 *  copy, and after this the live suite says the same thing. Refused while
 *  Playwright runs — the agent's edit is inert to the run either way, and a
 *  restore mid-execution would only race the agent for the same files. */
export function restoreSpecEdits(ctx: RunContext, expectedRevision?: string): RestoreSpecEditsResult {
  if (ctx.playwrightPty) return { ok: false, reason: 'tests-running' }
  const live = ctx.feature.featureDir
  if (ctx.suiteDir === live) return { ok: false, reason: 'nothing-to-restore' }
  const runtimeInputs = suiteRuntimeInputTargets(ctx)
  if (expectedRevision) {
    const exact = restoreReviewedSuiteFiles(ctx.suiteDir, live, expectedRevision, runtimeInputs)
    if (!exact.ok) return exact
    const at = new Date().toISOString()
    recordSpecEdits(ctx, { at, revision: exact.revision, decision: 'restored', receipt: {
      decision: 'restored', review_revision: exact.revision, files: exact.restored, at,
      git: { status: 'not-requested' }, execution: { status: 'none' },
    } })
    return { ok: true, restored: exact.restored }
  }
  const review = suiteReviewFiles(ctx.suiteDir, live, runtimeInputs)
  // Preserve the browser's legacy spec-only action. The agent form explicitly
  // reviews and restores all changed suite files, including helpers and config.
  const pending = computePendingEdits(live, ctx.suiteDir)
  if (pending.length === 0) return { ok: false, reason: 'nothing-to-restore' }
  const revision = review.revision
  const restored: string[] = []
  try {
    // Refuse the whole restore before writing if an edited path now traverses
    // a symlink (including a broken one). Never follow it outside the suite.
    for (const edit of pending) {
      for (const root of [live, ctx.suiteDir]) {
        let target = root
        for (const segment of edit.file.split('/')) {
          target = path.join(target, segment)
          try {
            if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Restore path contains a symlink')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    }
    for (const edit of pending) {
      const liveFile = path.join(live, edit.file)
      if (edit.change === 'added') {
        fs.rmSync(liveFile)
      } else {
        fs.mkdirSync(path.dirname(liveFile), { recursive: true })
        fs.copyFileSync(path.join(ctx.suiteDir, edit.file), liveFile)
      }
      restored.push(edit.file)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.runnerLog?.warn(`restoring spec edits stopped after ${restored.length}/${pending.length}: ${reason}`)
    recordSpecEdits(ctx)
    return { ok: false, reason: 'restore-failed' }
  }
  // The legacy browser action may restore specs while leaving other reviewed
  // files alone. Do not claim that it settled a whole-suite agent review.
  const fullyRestored = review.files.every((file) => restored.includes(file.file))
  recordSpecEdits(ctx, fullyRestored ? { at: new Date().toISOString(), revision, decision: 'restored' } : undefined)
  return { ok: true, restored }
}

/** The runner's own adopt, for the one sanctioned "edit the spec" path: a run
 *  with zero editable repos (`detectHealMode` → `test`), where Canary itself
 *  told the agent to fix the spec. Without it the agent's fix lands in the
 *  live dir while every rerun executes the run-start copy, and the repair can
 *  never pass. Called by the heal loops on the agent's signal, before the
 *  rerun; keyed on the heal MODE, never on a verdict. Returns the adopted
 *  files, or nothing when there is no copy, nothing pending, or app code. */
export async function adoptTestHealSpecEdits(ctx: RunContext): Promise<string[]> {
  if (ctx.suiteDir === ctx.feature.featureDir) return []
  if (detectHealMode(ctx.paths.manifestPath) !== 'test') return []
  if (computePendingEdits(ctx.feature.featureDir, ctx.suiteDir).length === 0) return []
  const adopted = await adoptPendingSpecEdits(ctx, 'test-heal')
  return adopted.ok ? adopted.adopted : []
}

type AdoptCoreResult =
  | { ok: true; adopted: string[] }
  | { ok: false; reason: 'nothing-to-adopt' | 'snapshot-failed' | 'review-changed' }

/** Re-take the snapshot over the live suite, re-baseline the dirty record and
 *  record the adoption. No signal: who reruns, and how, is the caller's. */
async function adoptPendingSpecEdits(ctx: RunContext, by: SpecEditsAdoptedBy, expectedRevision?: string, git?: TestReviewGitReceipt): Promise<AdoptCoreResult> {
  const live = ctx.feature.featureDir
  const hadSnapshot = ctx.suiteDir !== live
  const pending = hadSnapshot ? computePendingEdits(live, ctx.suiteDir) : []
  const reviewed = hadSnapshot && by === 'human' && expectedRevision !== undefined
    ? await buildSuiteReview(ctx.suiteDir, live, suiteRuntimeInputTargets(ctx)) : undefined
  if (reviewed && reviewed.revision !== expectedRevision) return { ok: false, reason: 'review-changed' }
  if (hadSnapshot && pending.length === 0 && !reviewed?.files.length) return { ok: false, reason: 'nothing-to-adopt' }
  // With no copy yet (the boundary was unavailable at boot) adopting means
  // taking the first one: every spec the live suite holds is what gets adopted.
  const adopted = reviewed ? reviewed.files.map((edit) => edit.file)
    : hadSnapshot ? pending.map((edit) => edit.file) : Object.keys(hashFeatureSpecs(live)).sort()

  let installedSpecEdits: RunManifest['specEdits']
  const adoptionPatch = (): Partial<RunManifest> => {
    const previous = readManifest(ctx.paths.manifestPath)?.specEdits
    const at = new Date().toISOString()
    const remaining = computePendingEdits(live, ctx.suiteDir)
    const decision: TestReviewDecision | undefined = by === 'human' && expectedRevision ? {
      at, revision: expectedRevision, decision: 'adopted', receipt: {
        decision: 'accepted', review_revision: expectedRevision, files: adopted, at,
        git: git ?? { status: 'not-requested' }, execution: { status: 'rerun-requested', runId: ctx.runId },
      },
    } : undefined
    const reviewDecisions = [...(previous?.reviewDecisions ?? []), ...(decision ? [decision] : [])]
    installedSpecEdits = { checkedAt: at, pending: remaining, adopted: [...(previous?.adopted ?? []), { at, by, files: adopted, ...(expectedRevision ? { reviewRevision: expectedRevision } : {}) }], ...(reviewDecisions.length ? { reviewDecisions } : {}) }
    return {
      specEdits: installedSpecEdits,
      integrity: { hints: deriveIntegrityHints(remaining, (rel) => readLive(live, rel)), disclosure: INTEGRITY_HINT_DISCLOSURE },
    }
  }
  if (expectedRevision !== undefined) {
    // Snapshot metadata and the complete human receipt share one persistence
    // boundary. A failed write rolls back the staged snapshot before returning.
    const result = snapshotReviewedSuite(ctx, expectedRevision, adoptionPatch)
    if (!result.ok) return result
  } else snapshotSuite(ctx)
  if (ctx.suiteDir === live) return { ok: false, reason: 'snapshot-failed' }
  if (expectedRevision === undefined) ctx.stateSink.patchManifest(ctx.runId, adoptionPatch())
  await captureDirtySpecBaseline(ctx)
  // Re-baselining awaits external hooks. Any edits made in that window remain
  // pending against the installed copy; the completed receipt is preserved.
  const remaining = computePendingEdits(live, ctx.suiteDir)
  if (JSON.stringify(remaining) !== JSON.stringify(installedSpecEdits?.pending)) {
    const latest = readManifest(ctx.paths.manifestPath)?.specEdits ?? installedSpecEdits!
    ctx.stateSink.patchManifest(ctx.runId, {
      specEdits: { ...latest, checkedAt: new Date().toISOString(), pending: remaining },
      integrity: { hints: deriveIntegrityHints(remaining, (rel) => readLive(live, rel)), disclosure: INTEGRITY_HINT_DISCLOSURE },
    })
  }
  return { ok: true, adopted }
}

/** Copy the live feature dir to `paths.suiteSnapshotDir`, point the run at the
 *  copy and record it on the manifest. Replaces an existing copy, so adopting a
 *  mid-run edit is simply taking the snapshot again. An ordinary copy failure
 *  retains the legacy live-dir fallback and records that missing boundary. A
 *  reviewed fresh run fails closed instead: its exact approval is meaningful
 *  only when the approved bytes become the immutable run snapshot. */
export function snapshotSuite(ctx: RunContext): void {
  const live = ctx.feature.featureDir
  const target = ctx.paths.suiteSnapshotDir
  let approvalSource: string | undefined
  let approvalExclusions: string[] = []
  if (ctx.testReviewApproval) {
    approvalSource = path.join(path.dirname(ctx.runDir), ctx.testReviewApproval.sourceRunId, 'suite')
    approvalExclusions = suiteRuntimeInputTargetsForSnapshot(approvalSource)
    if (!fs.existsSync(approvalSource)
      || suiteReviewRevision(approvalSource, live, approvalExclusions) !== ctx.testReviewApproval.revision) {
      throw new Error('Approved test review changed before snapshot capture; fetch and approve the current revision.')
    }
  }
  prepareSuiteRuntimeInputs(ctx)
  const runtimeInputs = new Set(suiteRuntimeInputTargets(ctx))
  try {
    fs.rmSync(target, { recursive: true, force: true })
    copyDirRecursive(live, target, undefined, (relative) => skipSuiteSnapshotPath(relative) || runtimeInputs.has(relative))
    if (approvalSource && suiteReviewRevision(approvalSource, target, new Set([...approvalExclusions, ...runtimeInputs])) !== ctx.testReviewApproval!.revision) {
      throw new Error('Approved test review changed during snapshot capture; fetch and approve the current revision.')
    }
    saveSuiteTestRoster(target)
    ctx.suiteDir = target
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // A runtime env target may have been the last copied file. Never retain a
    // partial snapshot that can contain that secret after falling back live.
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
    ctx.suiteDir = live
    ctx.runnerLog?.warn(`suite snapshot failed; running the live suite dir: ${reason}`)
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'unavailable', at: new Date().toISOString(), reason },
    })
    if (ctx.testReviewApproval) {
      throw new Error(`Approved test review snapshot capture failed before tests started: ${reason}`)
    }
    return
  }
  try {
    materializeSuiteRuntimeInputs(ctx)
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    ctx.suiteDir = live
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'unavailable', at: new Date().toISOString(), reason },
    })
    throw new Error(`Suite runtime input setup failed before tests started: ${reason}`)
  }
  ctx.stateSink.patchManifest(ctx.runId, {
    suiteSnapshot: { kind: 'taken', dir: target, takenAt: new Date().toISOString(), digest: suiteDigest(live) },
  })
}

/** Stage and validate the copied bytes before replacing evidence. A late file
 * edit or failed copy must leave the old snapshot and verdict intact. */
function snapshotReviewedSuite(ctx: RunContext, expectedRevision: string, adoptionPatch: () => Partial<RunManifest>): { ok: true } | { ok: false; reason: 'review-changed' | 'snapshot-failed' } {
  const target = ctx.paths.suiteSnapshotDir
  let scratch: string | undefined
  let originalMoved = false
  let installed = false
  try {
    prepareSuiteRuntimeInputs(ctx)
    const runtimeInputs = new Set(suiteRuntimeInputTargets(ctx))
    if (ctx.suiteDir === ctx.feature.featureDir || suiteReviewRevision(target, ctx.feature.featureDir, runtimeInputs) !== expectedRevision) {
      return { ok: false, reason: 'review-changed' }
    }
    scratch = fs.mkdtempSync(`${target}.review-`)
    const staging = path.join(scratch, 'candidate')
    const backup = path.join(scratch, 'original')
    copyDirRecursive(ctx.feature.featureDir, staging, undefined, (relative) => skipSuiteSnapshotPath(relative) || runtimeInputs.has(relative))
    if (suiteReviewRevision(target, staging, runtimeInputs) !== expectedRevision) return { ok: false, reason: 'review-changed' }
    saveSuiteTestRoster(staging)
    fs.renameSync(target, backup)
    originalMoved = true
    fs.renameSync(staging, target)
    installed = true
    ctx.suiteDir = target
    materializeSuiteRuntimeInputs(ctx)
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'taken', dir: target, takenAt: new Date().toISOString(), digest: suiteDigest(target) },
      ...adoptionPatch(),
    })
    originalMoved = false
    return { ok: true }
  } catch (error) {
    if (originalMoved) {
      try {
        if (installed) fs.rmSync(target, { recursive: true, force: true })
        fs.renameSync(path.join(scratch!, 'original'), target)
        originalMoved = false
      } catch (rollbackError) {
        // Keep the original bytes on disk even if the filesystem refuses rollback.
        ctx.runnerLog?.warn(`suite rollback failed; original retained at ${scratch}: ${String(rollbackError)}`)
      }
    }
    ctx.runnerLog?.warn(`reviewed suite snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, reason: 'snapshot-failed' }
  } finally {
    if (scratch && !originalMoved) fs.rmSync(scratch, { recursive: true, force: true })
  }
}
