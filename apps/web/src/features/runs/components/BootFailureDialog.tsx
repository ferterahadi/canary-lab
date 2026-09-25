import type { RunBootFailure } from '@shared/run-state'
import { Modal } from '@/shared/ui/Overlays'
import { bootFailureSummary, type CompilerError } from '@/shared/ui/BootEvidence'

/** One compiler error as a row: the code, the path with its filename lit and
 *  its directory and position dimmed, then the message. A path is text, not an
 *  editor link — the run's worktree is usually gone by the time anyone reads it. */
export function CompilerErrorRow({ error, clamp = false }: { error: CompilerError; clamp?: boolean }) {
  const slash = error.file.lastIndexOf('/')
  return (
    <li className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-2.5 py-1.5">
      <span className="font-mono text-muted">{error.code ?? '—'}</span>
      <div className="min-w-0">
        <div className="break-all font-mono">
          <span className="text-muted">{error.file.slice(0, slash + 1)}</span>
          <span className="text-primary">{error.file.slice(slash + 1)}</span>
          <span className="text-muted">:{error.line}:{error.column}</span>
        </div>
        <p className={`mt-0.5 break-words text-secondary ${clamp ? 'line-clamp-2' : ''}`}>{error.message}</p>
      </div>
    </li>
  )
}

/**
 * Every compiler error in full — what the card's three clamped rows leave out.
 * Routed as `?run=…&dialog=boot-failure`; the run detail is all it needs, so a
 * cold load renders it whole. Nothing else: the raw output is one click away
 * behind the card's "Open service log", as a readable copy.
 */
export function BootFailureDialog({
  open,
  onClose,
  failure,
  errors,
}: {
  open: boolean
  onClose: () => void
  failure: RunBootFailure
  errors: CompilerError[]
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Boot failure · ${failure.service}`}
      status="failed"
      description={bootFailureSummary(failure)}
      width={720}
      testId="boot-failure-dialog"
    >
      <section className="px-4 py-3 text-[11px]">
        <div className="cl-rubric">Compiler errors · {errors.length}</div>
        <ul className="mt-1 divide-y divide-line">
          {errors.map((error) => <CompilerErrorRow key={`${error.file}:${error.line}:${error.column}`} error={error} />)}
        </ul>
      </section>
    </Modal>
  )
}
