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
import { readManifest } from './manifest'
import { captureDirtySpecBaseline } from './run-manifest-writer'
import { INTEGRITY_HINT_DISCLOSURE, deriveIntegrityHints } from './run-integrity-hints'

export type AdoptSpecEditsResult =
  | { ok: true; adopted: string[]; rerun: 'signalled' | 'not-waiting-for-signal' | 'signal-already-pending' }
  | { ok: false; reason: 'tests-running' | 'nothing-to-adopt' | 'snapshot-failed' }

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
    specEdits: { checkedAt: at, pending: [], adopted: [...previous, { at, files: adopted }] },
    integrity: { hints: [], disclosure: INTEGRITY_HINT_DISCLOSURE },
  })
  const signal = ctx.signalGate.observe('rerun', {
    hypothesis: 'A human adopted the edited spec(s) into this run.',
    fixDescription: `Adopted ${adopted.join(', ')}; rerunning the suite as it now reads.`,
    adoptedSpecEdits: adopted,
  })
  return { ok: true, adopted, rerun: signal.accepted ? 'signalled' : signal.reason }
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
