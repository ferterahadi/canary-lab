import { useState } from 'react'
import { GeneralTab } from './GeneralTab'
import { ReposTab } from './ReposTab'
import { PortsTab } from './PortsTab'
import { EnvsetsTab } from './EnvsetsTab'
import { PlaywrightTab } from './PlaywrightTab'
import { Modal, TrashIcon } from '@/shared/ui/atoms'
import { DeleteSuiteConfirm } from './DeleteSuiteConfirm'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'

type Tab = ConfigTab

interface Props {
  feature: string
  /** Whether a saved port overlay exists for this feature (overlay presence,
   *  from `/api/features`). Drives the Ports tab's Portified indicator. */
  portified?: boolean
  onClose: () => void
  onDeleted?: (feature: string) => void
  onRenamed?: (oldFeature: string, nextFeature: string) => void
  /** Uncontrolled seed — the tab this dialog opens on when the mount doesn't
   *  own the selection. Ignored once `tab` is supplied. */
  initialTab?: Tab
  /** Controlled tab + its setter. The routed mount (App) passes both so the
   *  open tab lives in the URL; the unrouted mount (the features list gear)
   *  passes neither and keeps the internal state. */
  tab?: Tab
  onTabChange?: (tab: Tab) => void
  /** Launch the port-ification wizard for this feature (from the Ports tab). */
  onStartPortify?: (feature: string) => void
  /** Reopen a past/active port-ification workflow (by id) from the Ports tab. */
  onOpenPortify?: (workflowId: string) => void
}

export function FeatureConfigEditor({ feature, portified = false, onClose, onDeleted, onRenamed, initialTab = 'general', tab: tabProp, onTabChange, onStartPortify, onOpenPortify }: Props) {
  const [internalTab, setInternalTab] = useState<Tab>(initialTab)
  const tab = tabProp ?? internalTab
  const setTab = (next: Tab) => { setInternalTab(next); onTabChange?.(next) }
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <>
      <Modal
        open
        onClose={onClose}
        eyebrow="Feature configuration"
        title={feature}
        width={960}
        height="88vh"
        headerActions={
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${feature}`}
            title="Delete suite"
            className="cl-icon-button h-7 w-7 shrink-0"
            style={{ border: '1px solid color-mix(in srgb, var(--danger) 36%, var(--border-default))', color: 'var(--danger)' }}
          >
            <TrashIcon />
          </button>
        }
        subheader={
          <>
            <nav className="cl-panel-header flex gap-1 px-3 py-1.5 text-xs">
              <TabButton active={tab === 'general'} onClick={() => setTab('general')}>General</TabButton>
              <TabButton active={tab === 'repos'} onClick={() => setTab('repos')}>Service</TabButton>
              <TabButton active={tab === 'ports'} onClick={() => setTab('ports')}>Ports</TabButton>
              <TabButton active={tab === 'envsets'} onClick={() => setTab('envsets')}>Envsets</TabButton>
              <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
            </nav>
            <div className="flex-1 min-h-0">
              {tab === 'general' && <GeneralTab feature={feature} onFeatureRenamed={(nextFeature) => onRenamed?.(feature, nextFeature)} />}
              {tab === 'repos' && <ReposTab feature={feature} />}
              {tab === 'ports' && <PortsTab feature={feature} portified={portified} onStartPortify={onStartPortify} onOpenPortify={onOpenPortify} />}
              {tab === 'envsets' && <EnvsetsTab feature={feature} />}
              {tab === 'playwright' && <PlaywrightTab feature={feature} />}
            </div>
          </>
        }
      />
      <DeleteSuiteConfirm
        feature={feature}
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onDeleted={() => { onDeleted?.(feature); onClose() }}
      />
    </>
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
