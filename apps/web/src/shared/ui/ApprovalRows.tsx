import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Approval, ApprovalField } from '@shared/approval'
import type { ApprovalsResource } from '../state/use-approvals'
import { displayError } from '@/shared/api/error-message'
import { capitalizeFirst, timeAgo } from '@/shared/lib/format'
import { StatusDot, type StatusDotState } from './atoms'
import { Tooltip } from './Tooltip'

/** How long a one-click answer can be taken back before it is sent. */
export const UNDO_MS = 4000

/** Still waiting on, or being applied for, the human — the Needs attention side. */
export const isOpenApproval = (item: Approval): boolean => item.status === 'pending' || item.status === 'answering'

// A question without its own title still names its state, so a settled row
// never reads as one that is waiting.
const FALLBACK_TITLE: Record<Approval['status'], string> = {
  pending: 'Decision needed', answering: 'Decision needed', answered: 'Decision recorded',
  expired: 'Decision expired', failed: 'Decision failed',
}
const DOT: Record<Approval['status'], StatusDotState> = {
  pending: 'warning', answering: 'running', answered: 'idle', expired: 'idle', failed: 'failed',
}
const fieldLabel = (name: string, field: ApprovalField): string => field.title ?? capitalizeFirst(name.replace(/_/g, ' '))
const choiceLabel = (item: Approval, value: unknown): string => item.display?.choices?.[String(value)]?.label ?? String(value)
const BUTTON = 'cl-button h-7 shrink-0 px-3 text-xs'

/** The one required choice a row can answer in a single click; any other
 *  question opens its form below the row instead. */
function singleChoice(item: Approval): { name: string; options: NonNullable<ApprovalField['enum']> } | null {
  const fields = Object.entries(item.schema.properties ?? {})
  if (fields.length !== 1) return null
  const [name, field] = fields[0]
  return field.enum && item.schema.required?.includes(name) ? { name, options: field.enum } : null
}

/** Load notices for the approvals list itself, shown above either tab. */
export function ApprovalNotices({ approvals, focus }: { approvals: ApprovalsResource; focus?: string | null }) {
  return <>
    {approvals.error && <p role="alert" className="px-5 py-3 text-xs text-danger">Approvals unavailable: {approvals.error}. Retrying automatically.</p>}
    {focus && approvals.confirmed && !approvals.items.some((item) => item.id === focus)
      && <p role="alert" className="px-5 py-3 text-xs text-secondary">This approval is unavailable. Ask the requesting chat to resume.</p>}
  </>
}

/** Same grid as a notification row: dot · title, then suite · age under it. */
function RowText({ item, outcome }: { item: Approval; outcome?: string }) {
  return <div className="min-w-[min(100%,16rem)] flex-1">
    <div className="flex items-center gap-2">
      <StatusDot state={DOT[item.status]} pulse={false} />
      <h3 className="min-w-0 truncate text-[13px] font-semibold" title={item.message}>
        {item.display?.title ?? FALLBACK_TITLE[item.status]}
        {outcome && <><span aria-hidden="true" className="mx-1.5 font-normal text-muted">→</span><span className="sr-only">: </span><span className="font-normal">{outcome}</span></>}
      </h3>
    </div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-secondary">
      {item.feature && <><span className="truncate">{item.feature}</span><span aria-hidden="true" className="text-muted">·</span></>}
      <time className="shrink-0 font-mono text-muted" dateTime={item.startedAt} title={new Date(item.startedAt).toLocaleString()}>{timeAgo(item.startedAt)}</time>
    </div>
    {/* A titled question keeps its full sentence for hover and screen readers;
        an untitled one has nothing else to explain it, so it shows. */}
    {item.display ? <p className="sr-only">{item.message}</p>
      : <p className="mt-1.5 whitespace-pre-wrap break-words pl-3.5 text-xs leading-relaxed text-secondary">{item.message}</p>}
  </div>
}

function Row({ item, focused, children }: { item: Approval; focused: boolean; children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => { if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' }) }, [focused])
  return <li ref={ref} className={`px-5 py-3 ${focused ? 'bg-selected' : ''}`} data-testid={`approval-${item.id}`}>{children}</li>
}

export function PendingApprovalRow({ item, focused, confirmed, answer }: {
  item: Approval; focused: boolean; confirmed: boolean; answer: ApprovalsResource['answer']
}) {
  const choice = singleChoice(item)
  const [held, setHeld] = useState<unknown>(undefined)
  const [formOpen, setFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = useRef<(() => void) | null>(null)
  const submit = async (values: Record<string, unknown>): Promise<void> => {
    setError(null)
    try { await answer(item.id, values) }
    catch (err) { setError(displayError(err, 'Could not submit the answer')); setHeld(undefined) }
  }
  // Leaving the row (closing the dialog, switching tab) sends a held answer
  // now rather than dropping it. A failure there needs no message: the
  // question stays pending and reappears in the banner and this tab.
  useEffect(() => () => {
    clearTimeout(timer.current)
    flush.current?.()
  }, [])
  const hold = (value: unknown): void => {
    const values = { [choice!.name]: value }
    setHeld(value)
    flush.current = () => { void answer(item.id, values).catch(() => undefined) }
    timer.current = setTimeout(() => { flush.current = null; void submit(values) }, UNDO_MS)
  }
  const undo = (): void => { clearTimeout(timer.current); flush.current = null; setHeld(undefined) }
  const holding = held !== undefined
  return <Row item={item} focused={focused}>
    {/* A narrow dialog wraps the controls under the title rather than
        squeezing it. The choices keep their space while Undo or "Applying…"
        sits over them, so answering never changes the row's size. */}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <RowText item={item} outcome={holding ? choiceLabel(item, held) : undefined} />
      <div className="relative ml-auto flex h-7 shrink-0 items-center gap-1.5">
        <div className={`flex items-center gap-1.5 ${holding || item.status === 'answering' ? 'invisible' : ''}`}>
          {choice ? choice.options.map((value) => {
            const detail = item.display?.choices?.[String(value)]?.detail
            const button = <button key={String(value)} type="button" className={BUTTON} disabled={!confirmed} onClick={() => hold(value)}>
              {choiceLabel(item, value)}{detail && <span className="sr-only">. {detail}</span>}
            </button>
            return detail ? <Tooltip key={String(value)} label={detail}>{button}</Tooltip> : button
          })
            : <button type="button" className={BUTTON} aria-expanded={formOpen} disabled={!confirmed} onClick={() => setFormOpen((v) => !v)}>{formOpen ? 'Close' : 'Answer'}</button>}
        </div>
        {item.status === 'answering' ? <span role="status" className="absolute right-0 text-xs text-secondary">Applying…</span>
          : holding && <button type="button" className={`${BUTTON} absolute right-0`} onClick={undo}>Undo</button>}
      </div>
    </div>
    {formOpen && item.status === 'pending' && <ApprovalForm item={item} confirmed={confirmed} submit={submit} />}
    {(error || item.error) && <p role="alert" className="mt-1.5 pl-3.5 text-xs text-danger">{error ?? item.error}</p>}
  </Row>
}

/** A question with more than one field, or free text, answered in place. */
function ApprovalForm({ item, confirmed, submit }: {
  item: Approval; confirmed: boolean; submit: (values: Record<string, unknown>) => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const set = (name: string, value: unknown): void => setValues((v) => ({ ...v, [name]: value }))
  return <form className="mt-3 space-y-3 pl-3.5" onSubmit={(event) => {
    event.preventDefault()
    setBusy(true)
    void submit(values).finally(() => setBusy(false))
  }}>
    {Object.entries(item.schema.properties ?? {}).map(([name, field]) => {
      const label = fieldLabel(name, field)
      const required = item.schema.required?.includes(name)
      const numeric = field.type === 'number' || field.type === 'integer'
      return <fieldset key={name} disabled={busy || !confirmed} className="space-y-1.5">
        <legend className="mb-1.5 text-xs font-semibold">{label}</legend>
        {field.description && !field.enum && <p className="text-[11px] text-secondary">{field.description}</p>}
        {field.enum ? <div className="flex flex-wrap gap-1.5">{field.enum.map((value) => {
          const selected = values[name] === value
          return <label key={String(value)} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${selected ? 'border-accent bg-selected' : 'border-line hover:bg-hover'}`}>
            <input type="radio" name={`${item.id}-${name}`} required={required} checked={selected} onChange={() => set(name, value)} />
            {choiceLabel(item, value)}
          </label>
        })}</div>
          : field.type === 'boolean' ? <input type="checkbox" aria-label={label} checked={values[name] === true} onChange={(e) => set(name, e.target.checked)} />
          : <input className="cl-input w-full" aria-label={label} type={numeric ? 'number' : 'text'} required={required}
            maxLength={field.maxLength} minLength={field.minLength} value={String(values[name] ?? '')}
            onChange={(e) => set(name, numeric ? Number(e.target.value) : e.target.value)} />}
      </fieldset>
    })}
    <button className={BUTTON} type="submit" disabled={busy || !confirmed}>{busy ? 'Submitting…' : 'Submit'}</button>
  </form>
}

/** History side: the question's title with what came of it, on one line. */
export function SettledApprovalRow({ item, focused }: { item: Approval; focused: boolean }) {
  // The first answered choice names the decision; free-text fields stay out of a one-line row.
  const choiceField = Object.entries(item.schema.properties ?? {}).find(([name, field]) => field.enum && item.answer?.[name] !== undefined)
  const chosen = choiceField ? item.answer![choiceField[0]] : undefined
  const outcome = item.status === 'expired' ? 'Expired' : item.status === 'failed' ? 'Failed'
    : chosen !== undefined ? choiceLabel(item, chosen) : 'Answered'
  return <Row item={item} focused={focused}>
    <RowText item={item} outcome={outcome} />
    {item.status !== 'answered' && item.error
      && <p className={`mt-1.5 pl-3.5 text-xs ${item.status === 'failed' ? 'text-danger' : 'text-secondary'}`}>{item.error}</p>}
  </Row>
}
