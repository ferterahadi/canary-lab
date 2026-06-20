import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import { connectEvaluationExport, type EvaluationExportConnection } from '../api/evaluation-export-socket'
import { connectWorkspaceEvents, type WorkspaceEventsConnection } from '../../runs/api/workspace-socket'
import type { EvaluationExportMode, EvaluationExportTask } from '../../../shared/api/types'

interface EvaluationExportContextValue {
  tasks: EvaluationExportTask[]
  latestTask: EvaluationExportTask | null
  selectedTask: EvaluationExportTask | null
  dialogOpen: boolean
  logsByTaskId: Record<string, string>
  startExport: (runId: string, mode: EvaluationExportMode) => Promise<EvaluationExportTask>
  taskForRun: (runId: string) => EvaluationExportTask | null
  openTask: (taskId?: string) => void
  closeDialog: () => void
  downloadTask: (taskId: string) => Promise<void>
  dismissTask: (taskId: string) => Promise<void>
}

const EvaluationExportContext = createContext<EvaluationExportContextValue | null>(null)

export interface EvaluationExportProviderProps {
  children: ReactNode
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
}

export function EvaluationExportProvider({ children, wsBase, WebSocketImpl }: EvaluationExportProviderProps) {
  const [tasksById, setTasksById] = useState<Record<string, EvaluationExportTask>>({})
  const [logsByTaskId, setLogsByTaskId] = useState<Record<string, string>>({})
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const connectionsRef = useRef<Record<string, EvaluationExportConnection>>({})
  const workspaceConnectionRef = useRef<WorkspaceEventsConnection | null>(null)
  const tasksByIdRef = useRef<Record<string, EvaluationExportTask>>({})

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
    if (connectionsRef.current[taskId]) return
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
    for (const task of tasks) {
      if (task.status === 'running' || !previous[task.taskId]) subscribeTask(task.taskId)
    }
  }, [subscribeTask])

  const forgetTask = useCallback((taskId: string): void => {
    connectionsRef.current[taskId]?.close()
    delete connectionsRef.current[taskId]
    setTasksById((current) => {
      const { [taskId]: _removed, ...rest } = current
      tasksByIdRef.current = rest
      const remaining = Object.values(rest).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setSelectedTaskId((selected) => {
        if (selected && selected !== taskId) return selected
        return remaining[0]?.taskId ?? null
      })
      setDialogOpen((open) => open && remaining.length > 0)
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
    setSelectedTaskId(task.taskId)
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
      })
    } catch {
      // Startup REST rehydration and direct mutation responses still keep the UI usable.
    }
    return () => {
      workspaceConnectionRef.current?.close()
      workspaceConnectionRef.current = null
    }
  }, [WebSocketImpl, forgetTask, rememberTask, subscribeTask, wsBase])

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
  const latestTask = tasks[0] ?? null
  const selectedTask = selectedTaskId ? tasksById[selectedTaskId] ?? null : latestTask

  const taskForRun = useCallback((runId: string): EvaluationExportTask | null => (
    tasks.find((task) => task.runId === runId) ?? null
  ), [tasks])

  const openTask = useCallback((taskId?: string): void => {
    const nextTaskId = taskId ?? latestTask?.taskId ?? null
    setSelectedTaskId(nextTaskId)
    if (nextTaskId) {
      if (!logsByTaskId[nextTaskId]) subscribeTask(nextTaskId)
      setDialogOpen(true)
    }
  }, [latestTask?.taskId, logsByTaskId, subscribeTask])

  const closeDialog = useCallback((): void => {
    setDialogOpen(false)
  }, [])

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
    latestTask,
    selectedTask,
    dialogOpen,
    logsByTaskId,
    startExport,
    taskForRun,
    openTask,
    closeDialog,
    downloadTask,
    dismissTask,
  }), [closeDialog, dialogOpen, dismissTask, downloadTask, latestTask, logsByTaskId, openTask, selectedTask, startExport, taskForRun, tasks])

  return (
    <EvaluationExportContext.Provider value={value}>
      {children}
    </EvaluationExportContext.Provider>
  )
}

export function useEvaluationExports(): EvaluationExportContextValue {
  const value = useContext(EvaluationExportContext)
  if (!value) throw new Error('useEvaluationExports must be used inside EvaluationExportProvider')
  return value
}
