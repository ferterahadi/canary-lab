import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import * as wizardApi from '@/shared/api/wizard'
import { useWorkspaceRecords, type RecordSyncState } from '@/shared/state/use-workspace-records'
import type { DraftRecord } from '@shared/draft-types'

// Live list of authoring drafts, fed by the REST list on mount and kept current
// by workspace events. Every draft is authored by an external MCP client, so
// this tracks records — it never starts, accepts or rejects an agent's work.
// A live draft surfaces in the Flight page's Test-authoring Activity rail; this context only tracks the records.
interface WizardDraftContextValue {
  /** Every persisted draft, including accepted external work. The visible
   *  task list below intentionally hides accepted records, but Flight Activity
   *  still needs that history to say who authored the files after the live
   *  task disappears. */
  sync: RecordSyncState
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
  const { records: draftsById, sync, remove: forgetDraft } = useWorkspaceRecords<DraftRecord>({
    list: wizardApi.listDrafts,
    idOf: (draft) => draft.draftId,
    decode: (event) => {
      if (event.type === 'draft-created' || event.type === 'draft-updated') return { kind: 'upsert', record: event.draft }
      if (event.type === 'draft-deleted') return { kind: 'remove', id: event.draftId }
      return null
    },
    wsBase,
    WebSocketImpl,
  })

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
      try { await wizardApi.cancelDraftGeneration(draftId) } catch { /* may already be stopped */ }
    }
    try { await wizardApi.deleteDraft(draftId) } catch { /* already gone */ }
    forgetDraft(draftId)
  }, [draftsById, forgetDraft])

  const value = useMemo<WizardDraftContextValue>(() => ({
    sync,
    records,
    drafts,
    deleteTask,
  }), [deleteTask, drafts, records, sync])

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
