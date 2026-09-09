import { useState } from 'react'
import type { NotificationTarget, WorkspaceNotification } from '@/shared/api/notifications'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Modal, StatusDot, ToastHost } from '@/shared/ui/atoms'
import { useNotifications } from './use-notifications'

function attentionRank(item: WorkspaceNotification): number {
  if (item.resolvedAt) return 3
  if (item.severity === 'danger') return 0
  return item.target && item.severity !== 'neutral' ? 1 : 2
}

export function NotificationCenter({ open, suppressToast = false, onOpenChange, onNavigate }: {
  open: boolean
  suppressToast?: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (target: NotificationTarget) => void
}) {
  const inbox = useNotifications()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const items = [...inbox.items].sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt))
  const unread = items.filter((item) => !item.readAt && !item.resolvedAt)
  const visible = unreadOnly ? unread : items
  const latest = unread.find((item) => item.target)
  const hasWeakerHint = unread.some((item) => item.severity === 'danger')
  const openItem = (item: WorkspaceNotification): void => {
    void inbox.read(item.id)
    onOpenChange(false)
    const target = item.target
    if (!target) return
    if (item.resolvedAt && target.kind === 'test-review') {
      onNavigate(target.runId ? { ...target, kind: 'run', runId: target.runId } : { kind: 'feature', feature: target.feature })
    } else onNavigate(target)
  }
  return (
    <>
      <StatusPill
        name="Notifications"
        dotState={inbox.error || hasWeakerHint ? 'failed' : unread.length ? 'warning' : 'idle'}
        count={unread.length}
        countTone={hasWeakerHint ? 'danger' : undefined}
        onClick={() => onOpenChange(true)}
        title={inbox.error ?? `${items.length} notifications. Open the inbox to review messages.`}
        ariaLabel={inbox.error ? 'Notifications unavailable — open to retry' : `Notifications, ${unread.length} unread`}
      />
      {!open && !suppressToast && latest && (
        <ToastHost toasts={[{ id: latest.id, title: latest.title, body: latest.body, sticky: true, dismissOnOpen: false, dismissLabel: 'Delete notification permanently', actionLabel: 'Open notifications', onClick: () => { onOpenChange(true); void inbox.read(latest.id) } }]} onDismiss={(id) => { void inbox.remove(id) }} />
      )}
      <Modal
        open={open}
        portal
        onClose={() => onOpenChange(false)}
        title="Notifications"
        description="Review alerts and follow up on work that needs you."
        ariaLabel="Notifications"
        testId="notification-center"
        width={640}
        stableScrollGutter
        subheader={
          <nav className="flex gap-5 border-b border-line px-5 pt-2" aria-label="Notification filter">
            <button className={`cl-tab ${!unreadOnly ? 'cl-tab-active' : ''}`} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All <span className="cl-count-chip">{items.length}</span></button>
            <button className={`cl-tab ${unreadOnly ? 'cl-tab-active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread <span className="cl-count-chip">{unread.length}</span></button>
          </nav>
        }
        footer={<p className="mr-auto text-[11px] text-secondary">Deleting a message does not resolve or stop its run. Deleted messages stay deleted after a restart.</p>}
      >
        {inbox.error && <div role="alert" className="px-5 pt-3 text-xs text-danger">{inbox.error} <button className="cl-button px-2 py-1" onClick={() => { void inbox.refresh() }}>Retry</button></div>}
        {inbox.loading && <p className="p-5 text-xs text-secondary">Loading notifications…</p>}
        {!inbox.loading && !inbox.error && !visible.length && <p className="px-5 py-10 text-center text-xs text-secondary">{unreadOnly ? 'No unread notifications.' : 'No notifications. New messages will appear here.'}</p>}
        <ul className="divide-y divide-line">{visible.map((item) => {
          const hint = !item.resolvedAt && item.severity === 'danger'
          const state = item.resolvedAt || item.severity === 'neutral' || !item.target ? 'idle' : hint ? 'failed' : 'warning'
          const label = item.resolvedAt ? 'Resolved' : hint ? 'Test integrity · Hint' : item.target?.kind === 'test-review' && item.severity === 'neutral' ? 'Tests changed' : item.target ? 'Needs input' : 'Note'
          const target = item.target
          const action = target?.kind === 'flight' ? 'Open flight →'
            : target?.kind === 'test-review' && !item.resolvedAt ? 'Review test changes →'
            : target && 'runId' in target && target.runId ? 'Open run →' : 'Open suite →'
          return <li key={item.id} className="px-5 py-4" data-testid={`notification-${item.id}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
              <StatusDot state={state} pulse={false} />
              <span className={hint ? 'text-danger' : 'text-secondary'}>{label}</span>
              {!item.readAt && <span className="cl-count-chip">Unread</span>}
              <time className="ml-auto text-secondary" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            </div>
            <h3 className="break-words text-[13px] font-semibold">{item.title}</h3>
            {item.body && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-secondary">{item.body}</p>}
            {target && 'feature' in target && <p className="mt-2 break-words font-mono text-[11px] text-secondary">{target.feature}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {target && <button className="cl-button-primary px-2.5 py-1.5 text-xs" onClick={() => openItem(item)}>{action}</button>}
              {!item.readAt && <button className="cl-button px-2.5 py-1.5 text-xs" disabled={inbox.busy} onClick={() => { void inbox.read(item.id) }}>Mark read</button>}
              <button className="ml-auto px-2 py-1.5 text-[11px] text-secondary hover:text-primary disabled:opacity-50" disabled={inbox.busy} onClick={() => { void inbox.remove(item.id) }}>Delete permanently</button>
            </div>
          </li>
        })}</ul>
      </Modal>
    </>
  )
}
