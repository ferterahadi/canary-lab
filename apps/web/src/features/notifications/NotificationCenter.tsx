import { useState } from 'react'
import type { NotificationTarget } from '@/shared/api/notifications'
import { StatusPill } from '@/shared/ui/StatusPill'
import { SlideOverPanel, ToastHost } from '@/shared/ui/atoms'
import { useNotifications } from './use-notifications'

export function NotificationCenter({ open, suppressToast = false, onOpenChange, onNavigate }: {
  open: boolean
  suppressToast?: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (target: NotificationTarget) => void
}) {
  const inbox = useNotifications()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const unread = inbox.items.filter((item) => !item.readAt && !item.resolvedAt)
  const latest = unread.find((item) => item.target)
  return (
    <>
      <StatusPill name="Notifications" dotState={inbox.error ? 'failed' : unread.length ? 'warning' : 'idle'} count={unread.length} onClick={() => onOpenChange(true)} title={inbox.error ?? `${inbox.items.length} notifications. Open the inbox to review or delete messages.`} ariaLabel={inbox.error ? 'Notifications unavailable — open to retry' : `Notifications, ${unread.length} unread`} />
      {!open && !suppressToast && latest && (
        <ToastHost toasts={[{ id: latest.id, title: latest.title, body: latest.body, sticky: true, dismissOnOpen: false, dismissLabel: 'Delete notification permanently', actionLabel: 'Open notifications', onClick: () => { onOpenChange(true); void inbox.read(latest.id) } }]} onDismiss={(id) => { void inbox.remove(id) }} />
      )}
      {open && (
        <SlideOverPanel portal onClose={() => onOpenChange(false)} ariaLabel="Notifications" testId="notification-center" header={
          <><h2 className="flex-1 text-sm font-semibold">Notifications <span className="cl-count-chip">{inbox.items.length}</span></h2><button type="button" className="cl-button px-2.5 py-1 text-xs" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : '+ Add'}</button><button type="button" className="cl-button px-2.5 py-1 text-xs" onClick={() => onOpenChange(false)}>Close</button></>
        }>
          <p className="px-4 pt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>Deleted notifications stay deleted, including after a restart. Deleting a message does not stop or resolve its run.</p>
          {inbox.error && <div role="alert" className="px-4 pt-3 text-xs" style={{ color: 'var(--danger)' }}>{inbox.error} <button className="cl-button px-2 py-1" onClick={() => { void inbox.refresh() }}>Retry</button></div>}
          {adding && <form className="m-3 flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-default)' }} onSubmit={(event) => {
            event.preventDefault()
            void inbox.add(title.trim(), body.trim()).then((saved) => { if (saved) { setTitle(''); setBody(''); setAdding(false) } })
          }}>
            <label className="text-xs">Title<input className="cl-input mt-1 w-full" value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="text-xs">Note (optional)<textarea className="cl-input mt-1 w-full" rows={3} value={body} maxLength={2000} onChange={(event) => setBody(event.target.value)} /></label>
            <button className="cl-button-primary self-start px-3 py-1.5 text-xs" disabled={inbox.busy || !title.trim()}>{inbox.busy ? 'Saving…' : 'Add notification'}</button>
          </form>}
          <div className="min-h-0 flex-1 overflow-auto p-3" style={{ scrollbarGutter: 'stable' }}>
            {inbox.loading && <p className="text-xs">Loading notifications…</p>}
            {!inbox.loading && !inbox.error && !inbox.items.length && <p className="p-3 text-xs" style={{ color: 'var(--text-secondary)' }}>No notifications. New messages will appear here, or add a note with + Add.</p>}
            <ul className="flex flex-col gap-2">{inbox.items.map((item) => <li key={item.id} className="rounded-md border p-3" data-testid={`notification-${item.id}`} style={{ borderColor: 'var(--border-default)' }}>
              <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: item.resolvedAt ? 'var(--text-secondary)' : item.target ? 'var(--warning)' : 'var(--text-secondary)' }}>
                <span>{item.resolvedAt ? 'Resolved' : item.target ? 'Needs input' : 'Note'}</span><span className="flex-1" />{!item.readAt && <span>Unread</span>}<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
              </div>
              <div className="break-words text-[13px] font-medium">{item.title}</div>
              {item.body && <p className="mt-1 whitespace-pre-wrap break-words text-xs" style={{ color: 'var(--text-secondary)' }}>{item.body}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {item.target && <button className="cl-button-primary px-2.5 py-1 text-xs" onClick={() => {
                  void inbox.read(item.id)
                  onOpenChange(false)
                  if (item.target) onNavigate(item.resolvedAt && item.target.kind === 'test-review' ? { ...item.target, kind: 'run' } : item.target)
                }}>{item.target.kind === 'flight' ? 'Open flight →' : item.target.kind === 'test-review' && !item.resolvedAt ? 'Review test changes →' : 'Open run →'}</button>}
                {!item.readAt && <button className="cl-button px-2.5 py-1 text-xs" disabled={inbox.busy} onClick={() => { void inbox.read(item.id) }}>Mark read</button>}
                <button className="cl-button px-2.5 py-1 text-xs" disabled={inbox.busy} onClick={() => { void inbox.remove(item.id) }}>Delete permanently</button>
              </div>
            </li>)}</ul>
          </div>
        </SlideOverPanel>
      )}
    </>
  )
}
