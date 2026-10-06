import { useState } from 'react'
import type { Approval } from '@shared/approval'
import type { ApprovalsResource } from '../state/use-approvals'

export function ApprovalCards({ approvals, focus }: { approvals: ApprovalsResource; focus?: string | null }) {
  const visible = approvals.items.filter((item) => item.status === 'pending' || item.status === 'answering' || item.id === focus)
  return <section aria-label="Approvals" className="space-y-3 px-5 py-3">
    {approvals.error && <p role="alert" className="text-xs text-danger">Approvals unavailable: {approvals.error}. Retrying automatically.</p>}
    {focus && approvals.confirmed && !approvals.items.some((item) => item.id === focus)
      && <p role="alert" className="text-xs text-secondary">This approval is unavailable. Ask the requesting chat to resume.</p>}
    {visible.map((item) => <ApprovalCard key={item.id} item={item} confirmed={approvals.confirmed} answer={approvals.answer} />)}
  </section>
}
function ApprovalCard({ item, confirmed, answer }: {
  item: Approval; confirmed: boolean; answer: ApprovalsResource['answer']
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = item.status === 'pending'
  const submit = async (): Promise<void> => {
    if (busy || !confirmed || !pending) return
    setBusy(true); setError(null)
    try { await answer(item.id, values) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not submit the answer') }
    finally { setBusy(false) }
  }
  return <article className="rounded-md border border-line bg-surface p-3" data-testid={`approval-${item.id}`}>
    <h3 className="text-sm font-semibold">{item.feature ? `${item.feature} · ` : ''}Approval {pending ? 'needed' : item.status}</h3>
    <p className="mt-2 whitespace-pre-wrap text-xs text-secondary">{item.message}</p>
    <p className="mt-1 text-xs text-muted">Answer here or in the requesting chat. Both use this same decision.</p>
    {pending ? <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {Object.entries(item.schema.properties ?? {}).map(([name, field]) => <fieldset key={name} disabled={busy || !confirmed}>
        <legend className="mb-1 text-xs font-semibold">{field.title ?? name}</legend>
        {field.description && <p className="mb-1 text-xs text-secondary">{field.description}</p>}
        {field.enum ? field.enum.map((choice) => <label key={String(choice)} className="mb-1 flex items-center gap-2 text-xs">
          <input type="radio" name={`${item.id}-${name}`} required={item.schema.required?.includes(name)}
            checked={values[name] === choice} onChange={() => setValues((v) => ({ ...v, [name]: choice }))} />{String(choice)}
        </label>) : field.type === 'boolean' ? <input type="checkbox" aria-label={field.title ?? name}
          checked={values[name] === true} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.checked }))} />
          : <input className="cl-input w-full" aria-label={field.title ?? name} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
            required={item.schema.required?.includes(name)} maxLength={field.maxLength} minLength={field.minLength}
            value={String(values[name] ?? '')} onChange={(e) => setValues((v) => ({ ...v, [name]: field.type === 'number' || field.type === 'integer' ? Number(e.target.value) : e.target.value }))} />}
      </fieldset>)}
      <button className="cl-button px-3 py-1.5 text-xs" type="submit" disabled={busy || !confirmed}>{busy ? 'Submitting…' : 'Submit decision'}</button>
    </form> : <p role="status" className="mt-3 text-xs text-secondary">{item.status === 'answered'
      ? `Answered${item.answer ? `: ${Object.values(item.answer).join(' · ')}` : ''}. The requesting chat can continue with the recorded result.`
      : item.status === 'answering' ? 'Applying your decision…' : item.error ?? 'Ask the requesting chat to resume.'}</p>}
    {(error || (pending && item.error)) && <p role="alert" className="mt-2 text-xs text-danger">{error ?? item.error}</p>}
  </article>
}
