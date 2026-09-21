import path from 'path'
import type { RunStore } from './run-store'

const decisions = new Map<string, Promise<unknown>>()

/** Different routes, tabs and MCP forms can settle the same live suite. Keep
 * their revision check and mutation in one queue, including different runs
 * which share that suite, so a competing decision sees the first receipt. */
export async function withRunReviewLock<T>(store: RunStore, runId: string, apply: () => Promise<T>): Promise<T> {
  const featureDir = store.get(runId)?.manifest.featureDir
  const key = path.resolve(featureDir ?? path.join(store.logsDir, runId))
  const previous = decisions.get(key)
  const result = Promise.resolve(previous).catch(() => { /* the next request must still inspect durable state after a failed mutation */ }).then(apply)
  decisions.set(key, result)
  try { return await result } finally { if (decisions.get(key) === result) decisions.delete(key) }
}
