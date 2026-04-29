import type { DraftRecord, PlanStep } from '../../api/types'
import { AgentLogPanel } from './AgentLogPanel'

interface Props {
  draft: DraftRecord
  onAccept: () => void
  onReject: () => void
  onRetry: () => void
  acting: boolean
}

// Step 2: review the agent's generated test plan. Read-only — editing the
// plan items lands in a follow-up slice. While `status === 'planning'` we
// stream the agent log and show a spinner; once `plan-ready` the buttons
// activate. On `error` we surface the message and offer a retry.
export function PlanReviewStep({ draft, onAccept, onReject, onRetry, acting }: Props): JSX.Element {
  const { status } = draft

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {status === 'planning' && (
            <>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
                Agent is drafting the test plan…
              </div>
              <AgentLogPanel draftId={draft.draftId} initialBuffer={draft.planAgentLogTail} />
            </>
          )}

          {status === 'error' && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="mb-2 font-medium">Plan generation failed.</div>
              <div className="font-mono text-[11px]">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {(status === 'plan-ready' || status === 'generating' || status === 'spec-ready' || status === 'accepted') && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                Generated plan
              </div>
              <PlanList plan={(draft.plan as PlanStep[] | undefined) ?? []} />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-3">
        {status === 'error' ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={acting}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:opacity-50"
          >
            Retry
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={acting || status !== 'plan-ready'}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {acting ? 'Working…' : 'Accept plan'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function PlanList({ plan }: { plan: PlanStep[] }): JSX.Element {
  if (plan.length === 0) {
    return <div className="text-xs italic text-zinc-500">Plan is empty.</div>
  }
  return (
    <ol className="space-y-3">
      {plan.map((item, i) => (
        <li key={i} className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-xs">
          <div className="font-medium text-zinc-100">{item.step}</div>
          {item.actions.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-zinc-300">
              {item.actions.map((a, j) => (
                <li key={j}>{a}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 italic text-zinc-400">{item.expectedOutcome}</div>
        </li>
      ))}
    </ol>
  )
}
