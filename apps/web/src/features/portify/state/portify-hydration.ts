import { ApiError } from '@/shared/api/internal'
import type { PortifyManifest } from '@/shared/api/client'
import type { createObservedReads } from '@/shared/state/observed-reads'
import type { PortifyAction } from './portify-state'

type Hydration = { status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; error: string | null }
const idle: Hydration = { status: 'idle', error: null }

/** Detail demand is provider-scoped, like the manifests. Two mounted consumers
 * share one recovery timer; a hung HTTP read cannot monopolize its token. */
export function createPortifyHydration({ reads, read, apply, hasDetail }: {
  reads: ReturnType<typeof createObservedReads>
  read: (id: string) => Promise<PortifyManifest>
  apply: (action: PortifyAction) => void
  hasDetail: (id: string) => boolean
}) {
  const states = new Map<string, Hydration>()
  const demand = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<() => void>()
  let active = false
  const stopTimer = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id) }
  const set = (id: string, status: Hydration['status'], error: string | null = null) => {
    states.set(id, { status, error })
    for (const listener of listeners) listener()
  }
  const recover = (id: string) => {
    stopTimer(id)
    if (active && demand.has(id)) timers.set(id, setTimeout(() => {
      timers.delete(id)
      reads.invalidate(id)
      void load(id)
    }, 2500))
  }
  const settle = (id: string, status: 'ready' | 'missing') => { stopTimer(id); set(id, status) }
  const load = async (id: string): Promise<void> => {
    if (!active) return
    const token = reads.begin(id)
    if (!token) return
    set(id, 'loading')
    recover(id)
    try {
      const manifest = await read(id)
      if (!active || !reads.current(id, token)) return
      if (!manifest) throw new Error('Could not load port work')
      apply({ type: 'update', workflowId: id, manifest })
      settle(id, 'ready')
    } catch (error) {
      if (!active || !reads.current(id, token)) return
      if (error instanceof ApiError && error.status === 404) {
        apply({ type: 'detail-missing', workflowId: id })
        settle(id, 'missing')
      } else {
        set(id, 'error', error instanceof Error ? error.message : 'Could not load port work')
        recover(id)
      }
    } finally { reads.finish(id, token) }
  }
  return {
    start: () => { active = true; for (const id of demand.keys()) void load(id) },
    stop: () => { active = false; reads.clear(); for (const id of timers.keys()) stopTimer(id) },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: (id: string | null | undefined): Hydration => id ? states.get(id) ?? idle : idle,
    watch: (id: string) => {
      demand.set(id, (demand.get(id) ?? 0) + 1)
      if (demand.get(id) === 1) {
        if (hasDetail(id)) settle(id, 'ready')
        else void load(id)
      }
      return () => {
        const count = (demand.get(id) ?? 1) - 1
        if (count) demand.set(id, count)
        else {
          demand.delete(id)
          stopTimer(id)
          reads.invalidate(id)
          if (states.get(id)?.status === 'loading') set(id, 'idle')
        }
      }
    },
    load,
    retry: (id: string) => { reads.invalidate(id); void load(id) },
    observe: (action: PortifyAction) => {
      if (!active) return
      if (action.type === 'update') settle(action.workflowId, 'ready')
      if (action.type === 'removed') settle(action.workflowId, 'missing')
      if (action.type === 'snapshot') {
        const present = new Set(action.workflows.map((row) => row.workflowId))
        for (const id of demand.keys()) {
          if (action.details[id]) settle(id, 'ready')
          else if (!present.has(id)) settle(id, 'missing')
          else void load(id)
        }
      }
    },
  }
}
