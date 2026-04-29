import type { DraftRecord } from '../../api/types'
import { AgentLogPanel } from './AgentLogPanel'

interface Props {
  draft: DraftRecord
  featureName: string
  onAccept: () => void
  onReject: () => void
  acting: boolean
}

// Step 3: review the generated spec files. While `generating` we show the
// agent's log; on `spec-ready` we render the list of generated file paths
// with the planned target path. Loading the actual file content for a
// Shiki-highlighted preview lands in a follow-up slice — the v1 user can
// scroll the agent stream below to see what the agent emitted.
export function SpecReviewStep({
  draft,
  featureName,
  onAccept,
  onReject,
  acting,
}: Props): JSX.Element {
  const { status } = draft

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {status === 'generating' && (
            <>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
                Agent is generating the spec files…
              </div>
              <AgentLogPanel draftId={draft.draftId} initialBuffer={draft.specAgentLogTail} />
            </>
          )}

          {status === 'error' && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="mb-2 font-medium">Spec generation failed.</div>
              <div className="font-mono text-[11px]">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                Generated files
              </div>
              <p className="mb-2 text-xs text-zinc-500">
                Files will be written under <span className="font-mono">features/{featureName}/</span>.
              </p>
              <FileList files={draft.generatedFiles ?? []} featureName={featureName} />
            </div>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <details className="rounded border border-zinc-800">
              <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-400">
                Agent output
              </summary>
              <div className="px-3 pb-3">
                <AgentLogPanel draftId={draft.draftId} initialBuffer={draft.specAgentLogTail} />
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-3">
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
          disabled={acting || status !== 'spec-ready'}
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {acting ? 'Working…' : 'Accept & create feature'}
        </button>
      </div>
    </div>
  )
}

function FileList({ files, featureName }: { files: string[]; featureName: string }): JSX.Element {
  if (files.length === 0) {
    return <div className="text-xs italic text-zinc-500">No files generated.</div>
  }
  return (
    <ul className="space-y-2">
      {files.map((f) => (
        <li
          key={f}
          className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 font-mono text-[11px] text-zinc-300"
        >
          features/{featureName}/{f}
        </li>
      ))}
    </ul>
  )
}
