import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import { connectEvaluationExport, type EvaluationExportConnection } from '../api/evaluation-export-socket'
import type { EvaluationExportMode, EvaluationExportTask } from '../api/types'

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

  const rememberTask = useCallback((task: EvaluationExportTask): void => {
    setTasksById((current) => ({ ...current, [task.taskId]: task }))
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
        onData: (chunk) => appendLog(taskId, chunk),
        onExit: () => {
          void refreshTask(taskId)
        },
        onError: (err) => appendLog(taskId, `[evaluation] log stream error: ${err}\n`),
      })
    } catch (err) {
      appendLog(taskId, `[evaluation] log stream unavailable: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }, [WebSocketImpl, appendLog, refreshTask, wsBase])

  useEffect(() => {
    let cancelled = false
    api.listEvaluationExportTasks()
      .then((tasks) => {
        if (cancelled) return
        setTasksById(Object.fromEntries(tasks.map((task) => [task.taskId, task])))
        for (const task of tasks) {
          if (task.status === 'running') subscribeTask(task.taskId)
        }
      })
      .catch(() => { /* keep an empty task list on startup failures */ })
    return () => { cancelled = true }
  }, [subscribeTask])

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
    const running = Object.values(tasksById).filter((task) => task.status === 'running')
    if (running.length === 0) return
    const timer = setInterval(() => {
      for (const task of running) void refreshTask(task.taskId)
    }, 1500)
    return () => clearInterval(timer)
  }, [refreshTask, tasksById])

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
    if (nextTaskId) setDialogOpen(true)
  }, [latestTask?.taskId])

  const closeDialog = useCallback((): void => {
    setDialogOpen(false)
  }, [])

  const downloadTask = useCallback(async (taskId: string): Promise<void> => {
    const task = tasksById[taskId]
    if (!task) return
    await api.downloadEvaluationExportTask(task)
  }, [tasksById])

  const dismissTask = useCallback(async (taskId: string): Promise<void> => {
    connectionsRef.current[taskId]?.close()
    delete connectionsRef.current[taskId]
    try {
      await api.cancelEvaluationExportTask(taskId)
    } catch {
      // The server may already have forgotten the task after a restart. The
      // UI-level dismiss should still clear the stale local task.
    }
    setTasksById((current) => {
      const { [taskId]: _removed, ...rest } = current
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
