import { loadStudy } from './study'
import { sleep } from '../../shared/lib/sleep'

export async function studyStatus(root: string, options: { afterRevision?: number; waitMs?: number } = {}) {
  const waitMs = options.waitMs ?? 0
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000 ||
      options.afterRevision !== undefined && (!Number.isSafeInteger(options.afterRevision) || options.afterRevision < 0)) {
    throw new Error('Status requires a nonnegative revision and 0–60000 wait milliseconds')
  }
  const deadline = Date.now() + waitMs
  for (;;) {
    const manifest = loadStudy(root)
    const revision = manifest.revision ?? 0
    if (options.afterRevision === undefined || revision > options.afterRevision || Date.now() >= deadline) {
      return { revision, status: manifest.status, active: manifest.active, recorded: manifest.results.length, planned: manifest.attempts.length,
        lastResult: manifest.results.at(-1) ? { id: manifest.results.at(-1)!.id, outcome: manifest.results.at(-1)!.outcome,
          evidence: manifest.results.at(-1)!.evidence } : null, stopReason: manifest.stopReason ?? null }
    }
    // The file is authoritative. A missed push or a reconnect simply reads the
    // next revision; no watcher event is required for a correctness transition.
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())))
  }
}
