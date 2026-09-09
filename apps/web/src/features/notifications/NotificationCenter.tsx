import { useState } from 'react'
import type { NotificationTarget, WorkspaceNotification } from '@/shared/api/notifications'
import { timeAgo } from '@/shared/lib/format'
import { ChevronRightIcon, TrashIcon } from '@/shared/ui/Icons'
import { StatusPill } from '@/shared/ui/StatusPill'
import { IconButton, Modal, StatusDot, ToastHost } from '@/shared/ui/atoms'
import { useNotifications } from './use-notifications'

function attentionRank(item: WorkspaceNotification): number {
  if (item.resolvedAt) return 3
  if (item.severity === 'danger') return 0
  return item.target && item.severity !== 'neutral' ? 1 : 2
}

/** Severity rides the row's dot alone — not a coloured sentence beside the
 *  controls, and not a second tinted edge saying the same thing. */
type RowState = 'failed' | 'warning' | 'idle'

const DELETE_HINT = 'Delete permanently — this does not resolve or stop its run, and it stays deleted after a restart'

export function NotificationCenter({ open, suppressToast = false, onOpenChange, onNavigate }: {
  open: boolean
  suppressToast?: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (target: NotificationTarget) => void
}) {
  const inbox = useNotifications()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const items = [...inbox.items].sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt))
  const unread = items.filter((item) => !item.readAt && !item.resolvedAt)
  const visible = unreadOnly ? unread : items
  const active = visible.filter((item) => !item.resolvedAt)
  const settled = visible.filter((item) => item.resolvedAt)
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
  const row = (item: WorkspaceNotification, lead: boolean) => {
    const hint = !item.resolvedAt && item.severity === 'danger'
    const state: RowState = item.resolvedAt || item.severity === 'neutral' || !item.target ? 'idle' : hint ? 'failed' : 'warning'
    const target = item.target
    const action = target?.kind === 'flight' ? 'Open flight'
      : target?.kind === 'test-review' && !item.resolvedAt ? 'Review test changes'
      : target && 'runId' in target && target.runId ? 'Open run' : 'Open suite'
    // Every row's meta line answers the same two questions — what kind of alert
    // this is, and how old it is. The suite name is already the first word of
    // every title, and the hint's "not a verdict" caveat is in the body, so
    // neither is repeated here.
    const label = item.resolvedAt ? 'Resolved'
      : hint ? 'Test integrity · Hint'
      : target?.kind === 'test-review' && item.severity === 'neutral' ? 'Tests changed'
      : target ? 'Needs input' : 'Note'
    return (
      <li key={item.id} className="flex items-center gap-3 px-5 py-3" data-testid={`notification-${item.id}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot state={state} pulse={false} />
            <h3 className="break-words text-[13px] font-semibold">{item.title}</h3>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-3.5 text-[11px] text-secondary">
            <span>{label}</span>
            <span aria-hidden="true" className="text-muted">·</span>
            <time className="font-mono text-muted" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{timeAgo(item.createdAt)}</time>
            {!item.readAt && <span className="cl-count-chip">Unread</span>}
          </div>
          {item.body && <p className="mt-1.5 whitespace-pre-wrap break-words pl-3.5 text-xs leading-relaxed text-secondary">{item.body}</p>}
        </div>
        {/* Fixed width, right-aligned: the mark-read control only exists while a
            message is unread, and without a reserved column its disappearance
            would re-flow the title and body beside it. */}
        <div className="flex w-[104px] shrink-0 items-center justify-end gap-1">
          {!item.readAt && (
            <IconButton ariaLabel="Mark read" disabled={inbox.busy} onClick={() => { void inbox.read(item.id) }}>
              <span aria-hidden="true" className="text-[13px]">✓</span>
            </IconButton>
          )}
          <IconButton ariaLabel="Delete permanently" title={DELETE_HINT} disabled={inbox.busy} onClick={() => { void inbox.remove(item.id) }}>
            <TrashIcon />
          </IconButton>
          {target && (
            <>
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-line-strong" />
              <button
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-[13px] ${lead ? 'cl-button-primary' : 'cl-button'}`}
                aria-label={action}
                title={action}
                onClick={() => openItem(item)}
              >
                <span aria-hidden="true">→</span>
              </button>
            </>
          )}
        </div>
      </li>
    )
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
        // Held height, not shrink-to-fit: the tab filter and the resolved group
        // both change how many rows are in the body, and a dialog that resizes
        // under the pointer moves the control you were reaching for.
        height={440}
        stableScrollGutter
        subheader={
          <nav className="flex gap-5 border-b border-line px-5 pt-2" aria-label="Notification filter">
            <button className={`cl-tab ${!unreadOnly ? 'cl-tab-active' : ''}`} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All <span className="cl-count-chip">{items.length}</span></button>
            <button className={`cl-tab ${unreadOnly ? 'cl-tab-active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread <span className="cl-count-chip">{unread.length}</span></button>
          </nav>
        }
      >
        {inbox.error && <div role="alert" className="px-5 pt-3 text-xs text-danger">{inbox.error} <button className="cl-button px-2 py-1" onClick={() => { void inbox.refresh() }}>Retry</button></div>}
        {inbox.loading && <p className="p-5 text-xs text-secondary">Loading notifications…</p>}
        {!inbox.loading && !inbox.error && !visible.length && <p className="px-5 py-10 text-center text-xs text-secondary">{unreadOnly ? 'No unread notifications.' : 'No notifications. New messages will appear here.'}</p>}
        <ul className="divide-y divide-line">{active.map((item, index) => row(item, index === 0))}</ul>
        {settled.length > 0 && (
          <>
            <button
              className="flex w-full items-center gap-2 border-t border-line px-5 py-2.5 text-[11px] text-secondary transition-colors duration-150 hover:text-primary"
              aria-expanded={showResolved}
              onClick={() => setShowResolved(!showResolved)}
            >
              <span aria-hidden="true" className={showResolved ? 'rotate-90 transition-transform duration-150' : 'transition-transform duration-150'}><ChevronRightIcon /></span>
              Resolved <span className="cl-count-chip">{settled.length}</span>
            </button>
            {showResolved && <ul className="divide-y divide-line border-t border-line">{settled.map((item) => row(item, false))}</ul>}
          </>
        )}
      </Modal>
    </>
  )
}
