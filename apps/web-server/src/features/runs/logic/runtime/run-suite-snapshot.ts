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

export type AdoptSpecEditsResult =
  | { ok: true; adopted: string[]; rerun: 'signalled' | 'not-waiting-for-signal' | 'signal-already-pending' }
  | { ok: false; reason: 'tests-running' | 'nothing-to-adopt' | 'snapshot-failed' }

export type RestoreSpecEditsResult =
  | { ok: true; restored: string[] }
  | { ok: false; reason: 'tests-running' | 'nothing-to-restore' | 'restore-failed' }

// Top-level entries of a feature dir that are not suite content. Envsets are
// read from the LIVE dir by the env switcher and carry secrets; node_modules
// resolves by walking up from the copy exactly as it does from the live dir;
// .git is never suite content.
const SUITE_SNAPSHOT_SKIP = new Set(['envsets', 'node_modules', '.git'])

/** One digest over every spec's content, independent of listing order. Lets a
 *  reader check that the copy still holds what it held at run start. */
export function suiteDigest(suiteDir: string): string {
  const hashes = hashFeatureSpecs(suiteDir)
  const h = createHash('sha256')
  for (const rel of Object.keys(hashes).sort()) h.update(`${rel}\0${hashes[rel]}\n`)
  return h.digest('hex')
}

/** Re-measure the live suite against the copy and write the result to the
 *  manifest. Called after every Playwright exit, so the run's own record — and
 *  every MCP result derived from it — says which live edits the verdict never
 *  executed. Carries the adopted history forward; a run without a snapshot
 *  records nothing, since there is no boundary to measure against. */
export function recordSpecEdits(ctx: RunContext): void {
  if (ctx.suiteDir === ctx.feature.featureDir) return
  const adopted = readManifest(ctx.paths.manifestPath)?.specEdits?.adopted ?? []
  const pending = computePendingEdits(ctx.feature.featureDir, ctx.suiteDir)
  ctx.stateSink.patchManifest(ctx.runId, {
    specEdits: { checkedAt: new Date().toISOString(), pending, adopted },
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
 *  only path that moves the boundary — no verdict, hint or MCP tool does
 *  (D13); the HTTP route beside /approve-dirty is its sole caller. Refused
 *  while Playwright is executing the current copy: replacing files under a
 *  running process would corrupt the very run it is meant to inform. */
export async function adoptSpecEdits(ctx: RunContext): Promise<AdoptSpecEditsResult> {
  if (ctx.playwrightPty) return { ok: false, reason: 'tests-running' }
  const adopted = await adoptPendingSpecEdits(ctx, 'human')
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
 *  beside adopt (D9/D13); reached from its HTTP route alone, wrapped by no MCP
 *  tool. Nothing moves the boundary or reruns: the verdict already rests on the
 *  copy, and after this the live suite says the same thing. Refused while
 *  Playwright runs — the agent's edit is inert to the run either way, and a
 *  restore mid-execution would only race the agent for the same files. */
export function restoreSpecEdits(ctx: RunContext): RestoreSpecEditsResult {
  if (ctx.playwrightPty) return { ok: false, reason: 'tests-running' }
  const live = ctx.feature.featureDir
  if (ctx.suiteDir === live) return { ok: false, reason: 'nothing-to-restore' }
  const pending = computePendingEdits(live, ctx.suiteDir)
  if (pending.length === 0) return { ok: false, reason: 'nothing-to-restore' }
  const restored: string[] = []
  try {
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
  recordSpecEdits(ctx)
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
  | { ok: false; reason: 'nothing-to-adopt' | 'snapshot-failed' }

/** Re-take the snapshot over the live suite, re-baseline the dirty record and
 *  record the adoption. No signal: who reruns, and how, is the caller's. */
async function adoptPendingSpecEdits(ctx: RunContext, by: SpecEditsAdoptedBy): Promise<AdoptCoreResult> {
  const live = ctx.feature.featureDir
  const hadSnapshot = ctx.suiteDir !== live
  const pending = hadSnapshot ? computePendingEdits(live, ctx.suiteDir) : []
  if (hadSnapshot && pending.length === 0) return { ok: false, reason: 'nothing-to-adopt' }
  // With no copy yet (the boundary was unavailable at boot) adopting means
  // taking the first one: every spec the live suite holds is what gets adopted.
  const adopted = hadSnapshot ? pending.map((edit) => edit.file) : Object.keys(hashFeatureSpecs(live)).sort()

  snapshotSuite(ctx)
  if (ctx.suiteDir === live) return { ok: false, reason: 'snapshot-failed' }
  await captureDirtySpecBaseline(ctx)

  const previous = readManifest(ctx.paths.manifestPath)?.specEdits?.adopted ?? []
  const at = new Date().toISOString()
  ctx.stateSink.patchManifest(ctx.runId, {
    specEdits: { checkedAt: at, pending: [], adopted: [...previous, { at, by, files: adopted }] },
    integrity: { hints: [], disclosure: INTEGRITY_HINT_DISCLOSURE },
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
    copyDirRecursive(live, target, undefined, (rel) => SUITE_SNAPSHOT_SKIP.has(rel))
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
