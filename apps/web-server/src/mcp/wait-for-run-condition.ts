import type { RunStoreEvent } from '../features/runs/logic/run-store'
import { waitForCondition, type ConditionWaitOptions } from '../shared/wait-for-condition'

interface RunConditionOptions<T> extends Omit<ConditionWaitOptions<T>, 'subscribe'> {
  store: {
    onEvent(listener: (event: RunStoreEvent) => void): void
    offEvent(listener: (event: RunStoreEvent) => void): void
  }
  runId: string
}

export function waitForRunCondition<T>({ store, runId, ...options }: RunConditionOptions<T>): Promise<T> {
  return waitForCondition({ ...options, subscribe: (notify) => {
    const listener = (event: RunStoreEvent): void => { if (!event.runId || event.runId === runId) notify() }
    try { store.onEvent(listener) } catch (error) { store.offEvent(listener); throw error }
    return () => store.offEvent(listener)
  } })
}
