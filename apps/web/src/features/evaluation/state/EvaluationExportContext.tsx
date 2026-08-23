import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

// The log stream is its OWN context (same split invalidation.tsx documents): a
// localized export appends a chunk per agent event, and while `logsByTaskId`
// sat in the main value every one of those chunks re-rendered every
// `useEvaluationExports` consumer — StageDetail, the flight's report panels,
// the derived-stage hooks — at agent-output frequency. Only the log viewer
// subscribes here.
const EvaluationExportLogsContext = createContext<Record<string, string> | null>(null)

export interface EvaluationExportProviderProps {
  children: ReactNode
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
}

export function EvaluationExportProvider({ children, wsBase, WebSocketImpl }: EvaluationExportProviderProps) {
  const [tasksById, setTasksById] = useState<Record<string, EvaluationExportTask>>({})
  const [logsByTaskId, setLogsByTaskId] = useState<Record<string, string>>({})
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
    setLogsByTaskId((current) => ({
      ...current,
      [taskId]: `${current[taskId] ?? ''}${chunk}`,
    }))
  }, [])

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
    setLogsByTaskId((current) => {
      const { [taskId]: _removed, ...rest } = current
      return rest
    })
  }, [])

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

  return (
    <EvaluationExportContext.Provider value={value}>
      <EvaluationExportLogsContext.Provider value={logsByTaskId}>
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

/** The per-task log text, appended chunk by chunk while an export runs. Its own
 *  hook so only the log viewer re-renders per chunk — see the context comment. */
export function useEvaluationExportLogs(): Record<string, string> {
  const value = useContext(EvaluationExportLogsContext)
  if (!value) throw new Error('useEvaluationExportLogs must be used inside EvaluationExportProvider')
  return value
}
