import { withRunLifecycleLock } from './run-lifecycle-lock'
import type { RunStore } from './run-store'


/** Different routes, tabs and MCP forms can settle the same live suite. Keep
 * their revision check and mutation in one queue, including different runs
 * which share that suite, so a competing decision sees the first receipt. */
export async function withRunReviewLock<T>(store: RunStore, runId: string, apply: () => Promise<T>): Promise<T> {
  return withRunLifecycleLock(store.logsDir, store.get(runId)?.manifest.feature ?? runId, apply)
}
