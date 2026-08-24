import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import type { DraftRecord } from '@/shared/api/types'

// Live list of authoring drafts, fed by the REST list on mount and kept current
// by workspace events. Every draft is authored by an external MCP client, so
// this tracks records — it never starts, accepts or rejects an agent's work.
// A live draft surfaces on the flight page's Test-authoring stage (StageExternalWork); this context only tracks the records.
interface WizardDraftContextValue {
  drafts: DraftRecord[]
  deleteTask: (draftId: string) => Promise<void>
}

const WizardDraftContext = createContext<WizardDraftContextValue | null>(null)

export interface WizardDraftProviderProps {
  children: ReactNode
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
}

export function WizardDraftProvider({ children, wsBase, WebSocketImpl }: WizardDraftProviderProps) {
  const [draftsById, setDraftsById] = useState<Record<string, DraftRecord>>({})

  const forgetDraft = useCallback((draftId: string): void => {
    setDraftsById((current) => {
      const { [draftId]: _removed, ...rest } = current
      return rest
    })
  }, [])

  const rememberDraft = useCallback((draft: DraftRecord): DraftRecord => {
    if (!isVisibleWizardTask(draft)) {
      forgetDraft(draft.draftId)
      return draft
    }
    setDraftsById((current) => ({ ...current, [draft.draftId]: draft }))
    return draft
  }, [forgetDraft])

  const reconcileDraftList = useCallback((drafts: DraftRecord[]): void => {
    const visible = drafts.filter(isVisibleWizardTask)
    setDraftsById(Object.fromEntries(visible.map((draft) => [draft.draftId, draft])))
  }, [])

  useEffect(() => {
    let cancelled = false
    api.listDrafts()
      .then((drafts) => {
        if (!cancelled) reconcileDraftList(drafts)
      })
      .catch(() => { /* keep an empty task list on startup failures */ })
    return () => { cancelled = true }
  }, [reconcileDraftList])

  useEffect(() => {
    let conn: { close(): void } | null = null
    try {
      conn = connectWorkspaceEvents({
        wsBase,
        WebSocketImpl,
        onEvent: (event) => {
          if (event.type === 'draft-created' || event.type === 'draft-updated') {
            rememberDraft(event.draft)
            return
          }
          if (event.type === 'draft-deleted') {
            forgetDraft(event.draftId)
          }
        },
      })
    } catch {
      // The initial REST list and direct mutation responses still keep the wizard usable.
    }
    return () => conn?.close()
  }, [WebSocketImpl, forgetDraft, rememberDraft, wsBase])

  const drafts = useMemo(
    () => Object.values(draftsById)
      .filter(isVisibleWizardTask)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [draftsById],
  )
  // Stopping an in-flight authoring session settles the RECORD — there is no
  // local process to kill, the agent runs in the user's own client window.
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
    deleteTask,
  }), [deleteTask, drafts])

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
