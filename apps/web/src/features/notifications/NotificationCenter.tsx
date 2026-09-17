import { useState } from 'react'
import type { NotificationTarget, WorkspaceNotification } from '@/shared/api/notifications'
import { timeAgo } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/EmptyState'
import { CheckIcon, ChevronRightIcon, TrashIcon } from '@/shared/ui/Icons'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { StatusPill } from '@/shared/ui/StatusPill'
import { IconButton, Modal, StatusDot, ToastHost } from '@/shared/ui/atoms'
import { useNotifications } from './use-notifications'

function needsAttention(item: WorkspaceNotification): boolean {
  // Retained test-review messages may predate the warning severity mapping.
  return !item.resolvedAt && !!item.target && (item.target.kind === 'test-review' || item.severity !== 'neutral')
}

function attentionRank(item: WorkspaceNotification): number {
  if (item.resolvedAt) return 3
  if (item.severity === 'danger') return 0
  return needsAttention(item) ? 1 : 2
}

const DELETE_HINT = 'Delete permanently — this does not resolve or stop its run, and it stays deleted after a restart'

function notificationAction(item: WorkspaceNotification): string {
  const target = item.target
  return target?.kind === 'flight' || target?.kind === 'coverage' ? 'Open flight'
    : target?.kind === 'test-review' && !item.resolvedAt ? 'Review test changes'
    : target && 'runId' in target && target.runId ? 'Open run' : 'Open suite'
}

export function NotificationCenter({ open, suppressToast = false, onOpenChange, onNavigate }: {
  open: boolean
  suppressToast?: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (target: NotificationTarget) => void
}) {
  const inbox = useNotifications()
  const [showHistory, setShowHistory] = useState(false)
  const items = [...inbox.items].sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt))
  const attention = items.filter(needsAttention)
  const history = items.filter((item) => !needsAttention(item))
  const visible = showHistory ? history : attention
  const latest = attention.find((item) => !item.readAt && item.target)
  const hasWeakerHint = attention.some((item) => item.severity === 'danger')
  const openItem = (item: WorkspaceNotification): void => {
    void inbox.read(item.id)
    onOpenChange(false)
    const target = item.target
    if (!target) return
    if (item.resolvedAt && target.kind === 'test-review') {
      onNavigate(target.runId ? { ...target, kind: 'run', runId: target.runId } : { kind: 'feature', feature: target.feature })
    } else onNavigate(target)
  }
  const row = (item: WorkspaceNotification) => {
    const hint = !item.resolvedAt && item.severity === 'danger' && item.target?.kind === 'test-review'
    const state = needsAttention(item) ? 'warning' : 'idle'
    const target = item.target
    const reviewNeeded = target?.kind === 'test-review' && !item.resolvedAt
    const action = notificationAction(item)
    // Every row's meta line answers the same two questions — what kind of alert
    // this is, and how old it is. The suite name is already the first word of
    // every title, and the hint's "not a verdict" caveat is in the body, so
    // neither is repeated here.
    const label = item.resolvedAt ? 'Resolved'
      : hint ? 'Test integrity · Hint'
      : reviewNeeded ? 'Review needed'
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
        <div className={`flex ${reviewNeeded ? 'w-[144px]' : 'w-[104px]'} shrink-0 items-center justify-end gap-1`}>
          {!item.readAt && (
            <IconButton ariaLabel="Mark read" disabled={inbox.busy} onClick={() => { void inbox.read(item.id) }}>
              <CheckIcon />
            </IconButton>
          )}
          <IconButton ariaLabel="Delete permanently" title={DELETE_HINT} disabled={inbox.busy} onClick={() => { void inbox.remove(item.id) }}>
            <TrashIcon />
          </IconButton>
          {target && (
            <>
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-line-strong" />
              <button
                className={`cl-button inline-flex h-7 ${reviewNeeded ? 'gap-1 px-2' : 'w-7'} items-center justify-center rounded-md text-xs`}
                aria-label={action}
                title={action}
                onClick={() => openItem(item)}
              >
                {reviewNeeded && <span>Review</span>}<span aria-hidden="true" className="flex"><ChevronRightIcon /></span>
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
        dotState={inbox.error ? 'failed' : attention.length ? 'warning' : 'idle'}
        count={attention.length}
        countTone={hasWeakerHint ? 'boot' : undefined}
        onClick={() => onOpenChange(true)}
        title={inbox.error ?? `${attention.length} need attention. ${history.length} in history.`}
        ariaLabel={inbox.error ? 'Notifications unavailable — open to retry' : `Notifications, ${attention.length} need attention`}
      />
      {!open && !suppressToast && latest && (
        <ToastHost toasts={[{ id: latest.id, title: latest.title, body: latest.body, sticky: true, dismissOnOpen: false, dismissLabel: 'Delete notification permanently', actionLabel: notificationAction(latest), onClick: () => openItem(latest) }]} onDismiss={(id) => { void inbox.remove(id) }} />
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
        // Held height, not shrink-to-fit: filtering changes the number of rows,
        // and a dialog that resizes
        // under the pointer moves the control you were reaching for.
        height={440}
        stableScrollGutter
        subheader={
          <nav className="flex gap-5 border-b border-line px-5 pt-2" aria-label="Notification filter">
            <button className={`cl-tab ${!showHistory ? 'cl-tab-active' : ''}`} aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>Needs attention <span className="cl-count-chip">{attention.length}</span></button>
            <button className={`cl-tab ${showHistory ? 'cl-tab-active' : ''}`} aria-pressed={showHistory} onClick={() => setShowHistory(true)}>History <span className="cl-count-chip">{history.length}</span></button>
          </nav>
        }
      >
        {inbox.error && <div role="alert" className="px-5 pt-3 text-xs text-danger">{inbox.error} <button className="cl-button px-2 py-1" onClick={() => { void inbox.refresh() }}>Retry</button></div>}
        {inbox.loading && <p className="p-5 text-xs text-secondary">Loading notifications…</p>}
        {!inbox.loading && !inbox.error && !visible.length && (
          <div className="px-5 py-6">
            <EmptyState
              testId="notification-center-empty"
              {...(showHistory ? EMPTY_COPY.notificationsNoHistory : EMPTY_COPY.notificationsNoAttention)}
            />
          </div>
        )}
        <ul className="divide-y divide-line">{visible.map(row)}</ul>
      </Modal>
    </>
  )
}
