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
import { readManifest, type SpecEditsAdoptedBy } from './manifest'
import { captureDirtySpecBaseline } from './run-manifest-writer'
import { INTEGRITY_HINT_DISCLOSURE, deriveIntegrityHints } from './run-integrity-hints'
import { detectHealMode } from './auto-heal'
import { buildSuiteReview, skipSuiteSnapshotPath, suiteReviewRevision, suiteReviewFiles } from './suite-review'
import { saveSuiteTestRoster } from '../suite-test-roster'
import type { TestReviewDecision } from '../../../../../../../shared/test-review'

export type AdoptSpecEditsResult =
  | { ok: true; adopted: string[]; rerun: 'signalled' | 'not-waiting-for-signal' | 'signal-already-pending' }
  | { ok: false; reason: 'tests-running' | 'nothing-to-adopt' | 'snapshot-failed' | 'review-changed' }

export type RestoreSpecEditsResult =
  | { ok: true; restored: string[] }
  | { ok: false; reason: 'tests-running' | 'nothing-to-restore' | 'restore-failed' | 'review-changed' }

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
export async function adoptSpecEdits(ctx: RunContext, expectedRevision?: string): Promise<AdoptSpecEditsResult> {
  if (ctx.playwrightPty) return { ok: false, reason: 'tests-running' }
  const revision = expectedRevision ?? (ctx.suiteDir !== ctx.feature.featureDir ? suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir) : undefined)
  const adopted = await adoptPendingSpecEdits(ctx, 'human', revision)
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
  const review = suiteReviewFiles(ctx.suiteDir, live)
  if (expectedRevision && review.revision !== expectedRevision) return { ok: false, reason: 'review-changed' }
  // Preserve the browser's legacy spec-only action. The agent form explicitly
  // reviews and restores all changed suite files, including helpers and config.
  const pending = expectedRevision ? review.files : computePendingEdits(live, ctx.suiteDir)
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
async function adoptPendingSpecEdits(ctx: RunContext, by: SpecEditsAdoptedBy, expectedRevision?: string): Promise<AdoptCoreResult> {
  const live = ctx.feature.featureDir
  const hadSnapshot = ctx.suiteDir !== live
  const pending = hadSnapshot ? computePendingEdits(live, ctx.suiteDir) : []
  const reviewed = hadSnapshot && by === 'human' && expectedRevision !== undefined
    ? await buildSuiteReview(ctx.suiteDir, live) : undefined
  if (reviewed && reviewed.revision !== expectedRevision) return { ok: false, reason: 'review-changed' }
  if (hadSnapshot && pending.length === 0 && !reviewed?.files.length) return { ok: false, reason: 'nothing-to-adopt' }
  // With no copy yet (the boundary was unavailable at boot) adopting means
  // taking the first one: every spec the live suite holds is what gets adopted.
  const adopted = reviewed ? reviewed.files.map((edit) => edit.file)
    : hadSnapshot ? pending.map((edit) => edit.file) : Object.keys(hashFeatureSpecs(live)).sort()

  if (expectedRevision !== undefined) {
    const result = snapshotReviewedSuite(ctx, expectedRevision)
    if (!result.ok) return result
  } else snapshotSuite(ctx)
  if (ctx.suiteDir === live) return { ok: false, reason: 'snapshot-failed' }
  await captureDirtySpecBaseline(ctx)

  const previous = readManifest(ctx.paths.manifestPath)?.specEdits
  const at = new Date().toISOString()
  const remaining = computePendingEdits(live, ctx.suiteDir)
  const reviewDecisions: TestReviewDecision[] = [...(previous?.reviewDecisions ?? []), ...(by === 'human' && expectedRevision ? [{ at, revision: expectedRevision, decision: 'adopted' as const }] : [])]
  ctx.stateSink.patchManifest(ctx.runId, {
    specEdits: { checkedAt: at, pending: remaining, adopted: [...(previous?.adopted ?? []), { at, by, files: adopted, ...(expectedRevision ? { reviewRevision: expectedRevision } : {}) }], ...(reviewDecisions.length ? { reviewDecisions } : {}) },
    integrity: { hints: deriveIntegrityHints(remaining, (rel) => readLive(live, rel)), disclosure: INTEGRITY_HINT_DISCLOSURE },
  })
  return { ok: true, adopted }
}

/** Copy the live feature dir to `paths.suiteSnapshotDir`, point the run at the
 *  copy and record it on the manifest. Replaces an existing copy, so adopting a
 *  mid-run edit is simply taking the snapshot again. Best-effort at boot: on a
 *  failure the run keeps executing the live dir and the manifest says so — a
 *  silent fallback would let the UI and MCP results claim a boundary that was
 *  never there. */
export function snapshotSuite(ctx: RunContext): void {
  const live = ctx.feature.featureDir
  const target = ctx.paths.suiteSnapshotDir
  try {
    fs.rmSync(target, { recursive: true, force: true })
    copyDirRecursive(live, target, undefined, skipSuiteSnapshotPath)
    saveSuiteTestRoster(target)
    ctx.suiteDir = target
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'taken', dir: target, takenAt: new Date().toISOString(), digest: suiteDigest(live) },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.suiteDir = live
    ctx.runnerLog?.warn(`suite snapshot failed; running the live suite dir: ${reason}`)
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'unavailable', at: new Date().toISOString(), reason },
    })
  }
}

/** Stage and validate the copied bytes before replacing evidence. A late file
 * edit or failed copy must leave the old snapshot and verdict intact. */
function snapshotReviewedSuite(ctx: RunContext, expectedRevision: string): { ok: true } | { ok: false; reason: 'review-changed' | 'snapshot-failed' } {
  const target = ctx.paths.suiteSnapshotDir
  let scratch: string | undefined
  let originalMoved = false
  let installed = false
  try {
    if (ctx.suiteDir === ctx.feature.featureDir || suiteReviewRevision(target, ctx.feature.featureDir) !== expectedRevision) {
      return { ok: false, reason: 'review-changed' }
    }
    scratch = fs.mkdtempSync(`${target}.review-`)
    const staging = path.join(scratch, 'candidate')
    const backup = path.join(scratch, 'original')
    copyDirRecursive(ctx.feature.featureDir, staging, undefined, skipSuiteSnapshotPath)
    if (suiteReviewRevision(target, staging) !== expectedRevision) return { ok: false, reason: 'review-changed' }
    saveSuiteTestRoster(staging)
    fs.renameSync(target, backup)
    originalMoved = true
    fs.renameSync(staging, target)
    installed = true
    ctx.stateSink.patchManifest(ctx.runId, {
      suiteSnapshot: { kind: 'taken', dir: target, takenAt: new Date().toISOString(), digest: suiteDigest(target) },
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
