import { useEffect, useState } from 'react'
import { GeneralTab } from './config/GeneralTab'
import { ReposTab } from './config/ReposTab'
import { EnvsetsTab } from './config/EnvsetsTab'
import { PlaywrightTab } from './config/PlaywrightTab'
import { ConfirmModal } from './config/atoms'
import * as api from '../api/client'

type Tab = 'general' | 'repos' | 'envsets' | 'playwright'

interface Props {
  feature: string
  onClose: () => void
  onDeleted?: (feature: string) => void
}

export function FeatureConfigEditor({ feature, onClose, onDeleted }: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const closeDeleteConfirm = (): void => {
    if (deleting) return
    setConfirmDelete(false)
    setConfirmName('')
    setDeleteError(null)
  }

  const deleteCurrentFeature = async (): Promise<void> => {
    if (confirmName !== feature || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteFeature(feature, confirmName)
      onDeleted?.(feature)
      onClose()
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  return (
    <div
      className="cl-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="cl-modal flex h-[88vh] w-[min(960px,94vw)] flex-col overflow-hidden rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="cl-panel-header flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="cl-kicker">
              Feature configuration
            </div>
            <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {feature}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setConfirmDelete(true)
              setConfirmName('')
              setDeleteError(null)
            }}
            aria-label={`Delete ${feature}`}
            title="Delete feature"
            className="cl-icon-button h-7 w-7 shrink-0"
            style={{ border: '1px solid color-mix(in srgb, var(--danger) 36%, var(--border-default))', color: 'var(--danger)' }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M5.5 2h5l.5 1H14v1H2V3h3l.5-1zM3.5 5h9l-.7 8.2a1.5 1.5 0 0 1-1.5 1.3H5.7a1.5 1.5 0 0 1-1.5-1.3L3.5 5zm2.5 2v6h1V7H6zm3 0v6h1V7H9z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cl-icon-button h-7 w-7 shrink-0"
            style={{ border: '1px solid var(--border-default)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <nav
          className="cl-panel-header flex gap-1 px-3 py-1.5 text-xs"
        >
          <TabButton active={tab === 'general'} onClick={() => setTab('general')}>General</TabButton>
          <TabButton active={tab === 'repos'} onClick={() => setTab('repos')}>Repos & services</TabButton>
          <TabButton active={tab === 'envsets'} onClick={() => setTab('envsets')}>Envsets</TabButton>
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
        </nav>

        <div className="flex-1 min-h-0">
          {tab === 'general' && <GeneralTab feature={feature} />}
          {tab === 'repos' && <ReposTab feature={feature} />}
          {tab === 'envsets' && <EnvsetsTab feature={feature} />}
          {tab === 'playwright' && <PlaywrightTab feature={feature} />}
        </div>
        <ConfirmModal
          open={confirmDelete}
          title="Delete feature"
          message={
            <div className="space-y-3">
              <p>
                This permanently deletes <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code> from the features folder, including its config, Playwright tests, envsets, and helper files.
              </p>
              <p style={{ color: 'var(--danger)' }}>
                This cannot be undone. Type the feature name to confirm.
              </p>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                className="cl-input w-full rounded-md px-2 py-1.5 text-xs"
                style={{ fontFamily: 'var(--font-mono)' }}
                autoFocus
                placeholder={feature}
              />
              {deleteError && <p style={{ color: 'var(--danger)' }}>{deleteError}</p>}
            </div>
          }
          confirmLabel="Delete Feature"
          variant="danger"
          busy={deleting}
          confirmDisabled={confirmName !== feature}
          onCancel={closeDeleteConfirm}
          onConfirm={deleteCurrentFeature}
        />
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, onClick, children } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cl-tab shrink-0 whitespace-nowrap px-2.5 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  )
}
