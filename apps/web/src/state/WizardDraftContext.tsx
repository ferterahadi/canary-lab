import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import type { CreateDraftPayload, DraftRecord, PlanStep } from '../api/types'

interface WizardDraftContextValue {
  drafts: DraftRecord[]
  latestTask: DraftRecord | null
  selectedDraft: DraftRecord | null
  wizardOpen: boolean
  startNewWizard: () => void
  startDraft: (payload: CreateDraftPayload) => Promise<DraftRecord>
  openTask: (draftId?: string) => void
  closeWizard: () => void
  refreshDraft: (draftId: string) => Promise<DraftRecord | null>
  cancelGeneration: (draftId: string) => Promise<DraftRecord | null>
  acceptPlan: (draftId: string, plan?: PlanStep[], intentSummary?: string) => Promise<DraftRecord | null>
  acceptSpec: (draftId: string, featureName?: string) => Promise<DraftRecord | null>
  rejectAndDelete: (draftId: string) => Promise<void>
  deleteTask: (draftId: string) => Promise<void>
}

const WizardDraftContext = createContext<WizardDraftContextValue | null>(null)

export function WizardDraftProvider({ children }: { children: ReactNode }) {
  const [draftsById, setDraftsById] = useState<Record<string, DraftRecord>>({})
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const rememberDraft = useCallback((draft: DraftRecord): DraftRecord => {
    setDraftsById((current) => ({ ...current, [draft.draftId]: draft }))
    return draft
  }, [])

  const forgetDraft = useCallback((draftId: string): void => {
    setDraftsById((current) => {
      const { [draftId]: _removed, ...rest } = current
      return rest
    })
    setSelectedDraftId((selected) => (selected === draftId ? null : selected))
  }, [])

  const refreshDraft = useCallback(async (draftId: string): Promise<DraftRecord | null> => {
    try {
      return rememberDraft(await api.getDraft(draftId))
    } catch {
      return null
    }
  }, [rememberDraft])

  useEffect(() => {
    let cancelled = false
    api.listDrafts()
      .then((drafts) => {
        if (cancelled) return
        const visible = drafts.filter(isVisibleWizardTask)
        setDraftsById(Object.fromEntries(visible.map((draft) => [draft.draftId, draft])))
      })
      .catch(() => { /* keep an empty task list on startup failures */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const active = Object.values(draftsById).filter((draft) => isActiveWizardTask(draft.status))
    if (active.length === 0) return
    const timer = setInterval(() => {
      for (const draft of active) void refreshDraft(draft.draftId)
    }, 1000)
    return () => clearInterval(timer)
  }, [draftsById, refreshDraft])

  const drafts = useMemo(
    () => Object.values(draftsById)
      .filter(isVisibleWizardTask)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [draftsById],
  )
  const latestTask = drafts[0] ?? null
  const selectedDraft = selectedDraftId ? draftsById[selectedDraftId] ?? null : null

  const startNewWizard = useCallback((): void => {
    setSelectedDraftId(null)
    setWizardOpen(true)
  }, [])

  const startDraft = useCallback(async (payload: CreateDraftPayload): Promise<DraftRecord> => {
    const created = await api.createDraft(payload)
    const now = new Date().toISOString()
    const optimistic: DraftRecord = {
      draftId: created.draftId,
      prdText: payload.prdText,
      additionalNotes: payload.additionalNotes,
      prdDocuments: payload.prdDocuments ?? [],
      repos: payload.repos,
      featureName: payload.featureName,
      status: created.status,
      activeAgentStage: created.status === 'planning' ? 'planning' : undefined,
      createdAt: now,
      updatedAt: now,
    }
    rememberDraft(optimistic)
    setSelectedDraftId(created.draftId)
    setWizardOpen(true)
    void refreshDraft(created.draftId)
    return optimistic
  }, [refreshDraft, rememberDraft])

  const openTask = useCallback((draftId?: string): void => {
    const nextId = draftId ?? latestTask?.draftId ?? null
    setSelectedDraftId(nextId)
    if (nextId) setWizardOpen(true)
  }, [latestTask?.draftId])

  const closeWizard = useCallback((): void => {
    setWizardOpen(false)
  }, [])

  const cancelGeneration = useCallback(async (draftId: string): Promise<DraftRecord | null> => {
    await api.cancelDraftGeneration(draftId)
    return refreshDraft(draftId)
  }, [refreshDraft])

  const acceptPlan = useCallback(async (draftId: string, plan?: PlanStep[], intentSummary?: string): Promise<DraftRecord | null> => {
    await api.acceptPlan(draftId, plan, intentSummary)
    return refreshDraft(draftId)
  }, [refreshDraft])

  const acceptSpec = useCallback(async (draftId: string, featureName?: string): Promise<DraftRecord | null> => {
    await api.acceptSpec(draftId, featureName)
    return refreshDraft(draftId)
  }, [refreshDraft])

  const rejectAndDelete = useCallback(async (draftId: string): Promise<void> => {
    try { await api.rejectDraft(draftId) } catch { /* may already be terminal */ }
    try { await api.deleteDraft(draftId) } catch { /* already gone */ }
    forgetDraft(draftId)
    setWizardOpen((open) => open && selectedDraftId !== draftId)
  }, [forgetDraft, selectedDraftId])

  const deleteTask = useCallback(async (draftId: string): Promise<void> => {
    const draft = draftsById[draftId]
    if (draft && isActiveWizardTask(draft.status)) {
      try { await api.cancelDraftGeneration(draftId) } catch { /* may already be stopped */ }
    }
    try { await api.deleteDraft(draftId) } catch { /* already gone */ }
    forgetDraft(draftId)
  }, [draftsById, forgetDraft])

  const value = useMemo<WizardDraftContextValue>(() => ({
    drafts,
    latestTask,
    selectedDraft,
    wizardOpen,
    startNewWizard,
    startDraft,
    openTask,
    closeWizard,
    refreshDraft,
    cancelGeneration,
    acceptPlan,
    acceptSpec,
    rejectAndDelete,
    deleteTask,
  }), [
    acceptPlan,
    acceptSpec,
    cancelGeneration,
    closeWizard,
    deleteTask,
    drafts,
    latestTask,
    openTask,
    refreshDraft,
    rejectAndDelete,
    selectedDraft,
    startDraft,
    startNewWizard,
    wizardOpen,
  ])

  return (
    <WizardDraftContext.Provider value={value}>
      {children}
    </WizardDraftContext.Provider>
  )
}

export function useWizardDrafts(): WizardDraftContextValue {
  const value = useContext(WizardDraftContext)
  if (!value) throw new Error('useWizardDrafts must be used inside WizardDraftProvider')
  return value
}

export function isActiveWizardTask(status: DraftRecord['status']): boolean {
  return status === 'planning' || status === 'generating'
}

export function isVisibleWizardTask(draft: DraftRecord): boolean {
  return draft.status !== 'accepted'
}
