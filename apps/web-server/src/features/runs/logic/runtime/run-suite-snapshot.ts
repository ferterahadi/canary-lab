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
import type { RunContext } from './run-context'
import { copyDirRecursive } from '../../../../../../../shared/lib/copy-dir'
import { hashFeatureSpecs } from '../dirty-specs/detect'

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
