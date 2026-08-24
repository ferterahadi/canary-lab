import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import type { DraftRecord } from '@/shared/api/types'

// Live list of authoring drafts, fed by the REST list on mount and kept current
// by workspace events. Every draft is authored by an external MCP client, so
// this tracks records — it never starts, accepts or rejects an agent's work.
// A live draft surfaces in the Flight page's Test-authoring Activity rail; this context only tracks the records.
interface WizardDraftContextValue {
  /** Every persisted draft, including accepted external work. The visible
   *  task list below intentionally hides accepted records, but Flight Activity
   *  still needs that history to say who authored the files after the live
   *  task disappears. */
  records: DraftRecord[]
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
    setDraftsById((current) => ({ ...current, [draft.draftId]: draft }))
    return draft
  }, [])

  const reconcileDraftList = useCallback((drafts: DraftRecord[]): void => {
    setDraftsById(Object.fromEntries(drafts.map((draft) => [draft.draftId, draft])))
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

  const records = useMemo(
    () => Object.values(draftsById).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [draftsById],
  )
  const drafts = useMemo(() => records.filter(isVisibleWizardTask), [records])
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
    records,
    drafts,
    deleteTask,
  }), [deleteTask, drafts, records])

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
