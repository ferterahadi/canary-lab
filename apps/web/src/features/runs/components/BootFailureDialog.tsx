import type { ServiceManifestEntry } from '@/shared/api/types'
import type { RunBootFailure } from '@shared/run-state'
import { Modal } from '@/shared/ui/Overlays'
import { bootEvidenceLabel, bootFailureSummary, bootProcessLabel, compilerErrors, type CompilerError } from '@/shared/ui/BootEvidence'

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
 * Everything the boot-failure card leaves out: every compiler error in full, the
 * diagnostic facts, and the raw preserved output. Routed as
 * `?run=…&dialog=boot-failure`; the run detail is all it needs, so a cold load
 * renders it whole. No log button — the card that opened it already has one.
 */
export function BootFailureDialog({
  open,
  onClose,
  service,
  failure,
}: {
  open: boolean
  onClose: () => void
  /** The card's own service, so Command/Directory show only when they differ. */
  service?: ServiceManifestEntry
  failure: RunBootFailure
}) {
  const errors = compilerErrors(failure.excerpt)
  const command = failure.command && failure.command !== service?.command ? failure.command : null
  const cwd = failure.cwd && failure.cwd !== service?.cwd ? failure.cwd : null
  const process = bootProcessLabel(failure)
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
      <div className="space-y-5 px-4 py-3 text-[11px]">
        {errors.length > 0 && (
          <section>
            <div className="cl-rubric">Compiler errors · {errors.length}</div>
            <ul className="mt-1 divide-y divide-line">
              {errors.map((error) => <CompilerErrorRow key={`${error.file}:${error.line}:${error.column}`} error={error} />)}
            </ul>
          </section>
        )}
        <section>
          <div className="cl-rubric">Diagnostics</div>
          {/* Plain muted terms: a rubric here would read as another section heading. */}
          <dl className="mt-1.5 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-secondary">
            <dt className="text-muted">Detail</dt><dd>{failure.detail}</dd>
            {failure.classification && <><dt className="text-muted">Evidence</dt><dd className="font-mono">{bootEvidenceLabel(failure)}</dd></>}
            {process !== 'not captured' && <><dt className="text-muted">Process</dt><dd>{process}</dd></>}
            {command && <><dt className="text-muted">Command</dt><dd className="break-all font-mono">{command}</dd></>}
            {cwd && <><dt className="text-muted">Directory</dt><dd className="break-all font-mono">{cwd}</dd></>}
          </dl>
        </section>
        {failure.excerpt && (
          <section>
            <div className="cl-rubric">Preserved output</div>
            <pre className="mt-1.5 whitespace-pre-wrap break-words rounded border border-line bg-canvas p-2 font-mono text-secondary scrollbar-thin">
              {failure.excerpt}{failure.excerptTruncated ? '\n… excerpt truncated; open the service log for the full output' : ''}
            </pre>
          </section>
        )}
      </div>
    </Modal>
  )
}
