import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import { connectEvaluationExport, type EvaluationExportConnection } from '../api/evaluation-export-socket'
import { connectWorkspaceEvents, type WorkspaceEventsConnection } from '@/shared/api/workspace-socket'
import type { EvaluationExportMode, EvaluationExportTask } from '@/shared/api/types'

interface EvaluationExportContextValue {
  tasks: EvaluationExportTask[]
  startExport: (runId: string, mode: EvaluationExportMode) => Promise<EvaluationExportTask>
  taskForRun: (runId: string) => EvaluationExportTask | null
  taskById: (taskId: string) => EvaluationExportTask | null
  /** Ensure a task's log stream is attached (no-op when already streaming) —
   *  panels call this when they surface a task they didn't start. */
  watchTask: (taskId: string) => void
  downloadTask: (taskId: string) => Promise<void>
  dismissTask: (taskId: string) => Promise<void>
}

const EvaluationExportContext = createContext<EvaluationExportContextValue | null>(null)

interface EvaluationExportLogStore {
  append: (taskId: string, chunk: string) => void
  remove: (taskId: string) => void
  read: (taskId: string | null) => string
  readAll: () => Record<string, string>
  subscribe: (taskId: string | null, listener: () => void) => () => void
  subscribeAll: (listener: () => void) => () => void
}

interface EvaluationExportLogsContextValue {
  store: EvaluationExportLogStore
  watchTask: EvaluationExportContextValue['watchTask']
}

// A stable store, not a changing log map: task-scoped readers subscribe only to
// their task, while the legacy all-logs hook remains available to provider tests.
// This is the second half of the state/log context split — it prevents a chunk
// for task B from invalidating the visible rail for task A.
const EvaluationExportLogsContext = createContext<EvaluationExportLogsContextValue | null>(null)

const NOOP_WATCH_TASK: EvaluationExportContextValue['watchTask'] = () => {}

function createEvaluationExportLogStore(): EvaluationExportLogStore {
  let logs: Record<string, string> = {}
  const taskListeners = new Map<string, Set<() => void>>()
  const allListeners = new Set<() => void>()
  const notify = (listeners: ReadonlySet<() => void> | undefined): void => {
    for (const listener of listeners ?? []) listener()
  }
  return {
    append: (taskId, chunk) => {
      logs = { ...logs, [taskId]: `${logs[taskId] ?? ''}${chunk}` }
      notify(taskListeners.get(taskId))
      notify(allListeners)
    },
    remove: (taskId) => {
      const { [taskId]: _removed, ...remaining } = logs
      logs = remaining
      notify(taskListeners.get(taskId))
      notify(allListeners)
    },
    read: (taskId) => taskId ? logs[taskId] ?? '' : '',
    readAll: () => logs,
    subscribe: (taskId, listener) => {
      if (!taskId) return () => {}
      const listeners = taskListeners.get(taskId) ?? new Set<() => void>()
      listeners.add(listener)
      taskListeners.set(taskId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) taskListeners.delete(taskId)
      }
    },
    subscribeAll: (listener) => {
      allListeners.add(listener)
      return () => { allListeners.delete(listener) }
    },
  }
}

const EMPTY_LOG_STORE = createEvaluationExportLogStore()

export interface EvaluationExportProviderProps {
  children: ReactNode
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
}

export function EvaluationExportProvider({ children, wsBase, WebSocketImpl }: EvaluationExportProviderProps) {
  const [tasksById, setTasksById] = useState<Record<string, EvaluationExportTask>>({})
  const logStore = useMemo(createEvaluationExportLogStore, [])
  const connectionsRef = useRef<Record<string, EvaluationExportConnection>>({})
  const workspaceConnectionRef = useRef<WorkspaceEventsConnection | null>(null)
  const tasksByIdRef = useRef<Record<string, EvaluationExportTask>>({})
  /** Task ids ever attached to a log stream — see `subscribeTask`. */
  const subscribedRef = useRef<Set<string>>(new Set())

  const rememberTask = useCallback((task: EvaluationExportTask): void => {
    setTasksById((current) => {
      const next = { ...current, [task.taskId]: task }
      tasksByIdRef.current = next
      return next
    })
  }, [])

  const appendLog = useCallback((taskId: string, chunk: string): void => {
    logStore.append(taskId, chunk)
  }, [logStore])

  const refreshTask = useCallback(async (taskId: string): Promise<void> => {
    try {
      rememberTask(await api.getEvaluationExportTask(taskId))
    } catch (err) {
      appendLog(taskId, `[evaluation] unable to refresh task: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }, [appendLog, rememberTask])

  const subscribeTask = useCallback((taskId: string): void => {
    // At most one attach per task for the provider's lifetime. `connectionsRef`
    // alone can't carry this: `onExit` clears it, so a finished task could be
    // re-attached forever by any caller that retries. A task id belongs to one
    // export, so one attach is all it ever needs.
    if (subscribedRef.current.has(taskId)) return
    subscribedRef.current.add(taskId)
    try {
      connectionsRef.current[taskId] = connectEvaluationExport({
        taskId,
        wsBase,
        WebSocketImpl,
        onData: (chunk) => {
          appendLog(taskId, chunk)
          // The localized-rewrite agent pins its session ref the moment it
          // spawns — right at this marker. Pull the task so the dialog can swap
          // to the live AgentSessionView even when the workspace-event push is
          // delayed/unavailable; this per-task log stream is the reliable
          // channel. Self-limiting: once sessionRef lands we stop refetching.
          if (!tasksByIdRef.current[taskId]?.sessionRef && /\[agent:[^\]]+\] (starting localized rewrite|still running)/.test(chunk)) {
            void refreshTask(taskId)
          }
        },
        onExit: () => {
          delete connectionsRef.current[taskId]
          void refreshTask(taskId)
        },
        onError: (err) => appendLog(taskId, `[evaluation] log stream error: ${err}\n`),
        onUnavailable: (err) => appendLog(taskId, `[evaluation] log stream unavailable: ${err}\n`),
      })
    } catch (err) {
      appendLog(taskId, `[evaluation] log stream unavailable: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }, [WebSocketImpl, appendLog, refreshTask, wsBase])

  const reconcileTasks = useCallback((tasks: EvaluationExportTask[]): void => {
    const previous = tasksByIdRef.current
    const next = Object.fromEntries(tasks.map((task) => [task.taskId, task]))
    tasksByIdRef.current = next
    setTasksById(next)
    // Only live tasks get a stream here. A finished task's log is historical and
    // cannot change, so pulling all of them on mount cost one socket, one full
    // log transfer and one task refetch per past export (16 of each in a real
    // workspace) before anything had asked to see them. `watchTask` fetches on
    // demand when a panel actually surfaces one.
    for (const task of tasks) {
      if (task.status === 'running') subscribeTask(task.taskId)
    }
  }, [subscribeTask])

  const forgetTask = useCallback((taskId: string): void => {
    connectionsRef.current[taskId]?.close()
    delete connectionsRef.current[taskId]
    setTasksById((current) => {
      const { [taskId]: _removed, ...rest } = current
      tasksByIdRef.current = rest
      return rest
    })
    logStore.remove(taskId)
  }, [logStore])

  useEffect(() => {
    let cancelled = false
    api.listEvaluationExportTasks()
      .then((tasks) => {
        if (cancelled) return
        reconcileTasks(tasks)
      })
      .catch(() => { /* keep an empty task list on startup failures */ })
    return () => { cancelled = true }
  }, [reconcileTasks])

  const startExport = useCallback(async (
    runId: string,
    mode: EvaluationExportMode,
  ): Promise<EvaluationExportTask> => {
    const task = await api.startEvaluationExport(runId, mode)
    rememberTask(task)
    appendLog(task.taskId, `[evaluation] queued ${mode === 'raw' ? 'raw output' : 'localized output'} export\n`)
    subscribeTask(task.taskId)
    return task
  }, [appendLog, rememberTask, subscribeTask])

  useEffect(() => {
    try {
      workspaceConnectionRef.current = connectWorkspaceEvents({
        wsBase,
        WebSocketImpl,
        onEvent: (event) => {
          if (event.type === 'evaluation-export-created' || event.type === 'evaluation-export-updated') {
            rememberTask(event.task)
            if (event.type === 'evaluation-export-created' || event.task.status === 'running') {
              subscribeTask(event.task.taskId)
            }
            return
          }
          if (event.type === 'evaluation-export-deleted') {
            forgetTask(event.taskId)
          }
        },
        // The bus has no replay: an export created/completed while the socket
        // was down (e.g. across a server restart) never pushed. Re-list on
        // reconnect so the dialog reflects it without a manual refresh.
        onReconnect: () => {
          api.listEvaluationExportTasks()
            .then((tasks) => reconcileTasks(tasks))
            .catch(() => { /* a later valid push can still recover state */ })
        },
      })
    } catch {
      // Startup REST rehydration and direct mutation responses still keep the UI usable.
    }
    return () => {
      workspaceConnectionRef.current?.close()
      workspaceConnectionRef.current = null
    }
  }, [WebSocketImpl, forgetTask, reconcileTasks, rememberTask, subscribeTask, wsBase])

  useEffect(() => {
    return () => {
      for (const connection of Object.values(connectionsRef.current)) connection.close()
      connectionsRef.current = {}
    }
  }, [])

  const tasks = useMemo(
    () => Object.values(tasksById).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [tasksById],
  )

  const taskForRun = useCallback((runId: string): EvaluationExportTask | null => (
    tasks.find((task) => task.runId === runId) ?? null
  ), [tasks])

  const taskById = useCallback((taskId: string): EvaluationExportTask | null => (
    tasksById[taskId] ?? null
  ), [tasksById])

  // The on-demand path for a task this provider didn't start: panels call it
  // when they surface a past export, which is what pulls its historical log now
  // that mount no longer attaches every finished task. `subscribeTask` owns the
  // once-only guard, so this is safe to call from an effect on every render.
  const watchTask = useCallback((taskId: string): void => {
    subscribeTask(taskId)
  }, [subscribeTask])

  const downloadTask = useCallback(async (taskId: string): Promise<void> => {
    const task = tasksById[taskId]
    if (!task) return
    await api.downloadEvaluationExportTask(task)
  }, [tasksById])

  const dismissTask = useCallback(async (taskId: string): Promise<void> => {
    try {
      await api.cancelEvaluationExportTask(taskId)
    } catch {
      // The server may already have forgotten the task after a restart. The
      // UI-level dismiss should still clear the stale local task.
    }
    forgetTask(taskId)
  }, [forgetTask])

  const value = useMemo<EvaluationExportContextValue>(() => ({
    tasks,
    startExport,
    taskForRun,
    taskById,
    watchTask,
    downloadTask,
    dismissTask,
  }), [dismissTask, downloadTask, startExport, taskById, taskForRun, tasks, watchTask])
  const logValue = useMemo<EvaluationExportLogsContextValue>(() => ({
    store: logStore,
    watchTask,
  }), [logStore, watchTask])

  return (
    <EvaluationExportContext.Provider value={value}>
      <EvaluationExportLogsContext.Provider value={logValue}>
        {children}
      </EvaluationExportLogsContext.Provider>
    </EvaluationExportContext.Provider>
  )
}

export function useEvaluationExports(): EvaluationExportContextValue {
  const value = useContext(EvaluationExportContext)
  if (!value) throw new Error('useEvaluationExports must be used inside EvaluationExportProvider')
  return value
}

/** One task's live log plus the stable action that attaches its stream. A null
 *  task is an intentional no-op so generic stage rails stay provider-optional. */
export function useEvaluationExportLog(taskId: string | null): {
  log: string
  watchTask: EvaluationExportContextValue['watchTask']
} {
  const value = useContext(EvaluationExportLogsContext)
  const store = value?.store ?? EMPTY_LOG_STORE
  const subscribe = useCallback((listener: () => void) => (
    store.subscribe(taskId, listener)
  ), [store, taskId])
  const read = useCallback(() => store.read(taskId), [store, taskId])
  const log = useSyncExternalStore(subscribe, read, read)
  if (!value && taskId) {
    throw new Error('useEvaluationExportLog must be used inside EvaluationExportProvider')
  }
  return { log, watchTask: value?.watchTask ?? NOOP_WATCH_TASK }
}

/** Full log-map access is retained for provider-level diagnostics. Product
 *  surfaces should use `useEvaluationExportLog` and subscribe to one task. */
export function useEvaluationExportLogs(): Record<string, string> {
  const value = useContext(EvaluationExportLogsContext)
  const store = value?.store ?? EMPTY_LOG_STORE
  const logs = useSyncExternalStore(store.subscribeAll, store.readAll, store.readAll)
  if (!value) throw new Error('useEvaluationExportLogs must be used inside EvaluationExportProvider')
  return logs
}
