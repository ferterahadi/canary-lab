import { useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightCheckpoint, FlightManifest, FlightStage } from '@/shared/api/client'
import { evaluationArchiveFilename } from '@/shared/lib/format'
import { DiffView } from '@/shared/ui/DiffView'
import { useEvaluationExports } from '@/features/evaluation'
import { checkpointOptionLabel, checkpointTitle, evaluationTaskId, STAGE_COLUMN } from './stage-meta'
import { EXTERNAL_DRIVE_COPY, EXTERNAL_WORK_COPY, isExternallyDriven } from '../lib/external-work'
import { StatusDot } from '@/shared/ui/atoms'

/** Evaluation Report's explicit download (R15): as an `icon` on the at-a-glance
 *  card's kicker line — beside the archive it fetches — and (R71/W1, `primary`)
 *  as the done-state header primary. Instances carry distinct testIds. */
export function DownloadEvaluationAction({
  flight,
  stage,
  testId = 'flight-download-evaluation',
  primary = false,
  icon = false,
}: {
  flight: FlightManifest
  stage: FlightStage
  testId?: string
  primary?: boolean
  /** Icon-only, for the card's kicker line. */
  icon?: boolean
}) {
  const { downloadTask, taskById } = useEvaluationExports()
  const [failed, setFailed] = useState(false)
  const taskId = evaluationTaskId(stage, flight)
  // Gated on the TASK, not on a recorded zip PATH: the download fetches
  // `/api/evaluation-exports/<taskId>/download`, and a flight whose evidence came
  // from a read-time probe carries no path — the old path gate hid the download on
  // every derived flight that had a finished archive sitting on disk. A task the
  // client doesn't hold (a deleted export) has nothing to fetch, so the action
  // stays absent rather than clicking into a silent no-op.
  const task = taskId ? taskById(taskId) : null
  if (!taskId || !task?.downloadReady) return null
  const filename = evaluationArchiveFilename(task.feature, task.runId)
  const title = failed ? 'Download failed — click to retry' : `Download ${filename}`
  const download = () => {
    setFailed(false)
    downloadTask(taskId).catch(() => setFailed(true))
  }
  if (icon) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={download}
        aria-label={title}
        title={title}
        className="cl-icon-button h-6 w-6 shrink-0 text-[12px]"
        style={failed ? { color: 'var(--danger)' } : undefined}
      >
        ⬇
      </button>
    )
  }
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={download}
      title={title}
      className={`${primary ? 'cl-button-primary' : 'cl-button'} shrink-0 px-2.5 py-1 text-xs`}
      style={primary ? undefined : { color: failed ? 'var(--danger)' : 'var(--success)' }}
    >
      {/* One label for one file: the header, this card and the reports list all
          say "report". */}
      {failed ? 'Download failed — retry' : '⬇ Download report'}
    </button>
  )
}

export function CheckpointControls({
  flightId,
  flight,
  checkpoint,
  onResponded,
}: {
  flightId: string
  flight: FlightManifest
  checkpoint: FlightCheckpoint
  onResponded: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [envText, setEnvText] = useState('')
  // portify-apply 'revise': the choice needs feedback text, so its button
  // opens this composer instead of responding immediately. No read-only guard
  // on the composer below: the only thing that opens it is an option button
  // read-only never renders, and `readOnly` can never turn ON mid-mount (the
  // producer is sticky, so it only clears when the flight settles).
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseText, setReviseText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const respond = (response: { choice?: string; values?: Record<string, string>; data?: unknown; feedback?: string; token?: string }): void => {
    setBusy(true)
    setFailure(null)
    api.respondFlightCheckpoint(flightId, response)
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const data = (checkpoint.data ?? {}) as Record<string, unknown>
  const missing = Array.isArray(data.missing) ? (data.missing as string[]) : []
  const diff = typeof data.diff === 'string' ? data.diff : null
  const configError = typeof data.error === 'string' ? data.error : null

  // A hand-off to the client that started the flight: work in progress, not a
  // question. It drops every "you are the blocker" cue — amber chrome, the
  // pause glyph, the Recommended badge — because the expected next move is the
  // agent finishing, not a click. Its own two escape buttons went with the
  // read-only rule below; Abort in the flight's ⋯ menu is what replaced them.
  const externalWork = checkpoint.kind === 'external-work'
  // Every answer on this card belongs to the MCP client driving the flight —
  // including the hand-off's own two escape buttons, which were the last thing
  // on the page still inviting the human to act on the agent's behalf. The
  // question and its context stay visible (that is what a viewer wants); only
  // the answering goes. An `external-work` checkpoint only ever occurs on an
  // externally driven flight, so this one predicate covers both cases.
  const readOnly = isExternallyDriven(flight)
  // Identifies WHICH hand-off a submit answers. Without it the server's
  // stale-submit gate rejects every check from this side and silently re-parks,
  // so the button looked broken while doing nothing.
  const handOffId = typeof data.handOffId === 'string' ? data.handOffId : undefined
  const staleSubmission = data.lastRejection === 'stale_submission'

  // R71/W3: options render in outcome language (display map — the POSTed key
  // stays raw). The first option is the recommended default; past 3 options the
  // rest fold behind a disclosure so a fork never reads as a wall of buttons.
  const options = checkpoint.options ?? []
  const [showAllOptions, setShowAllOptions] = useState(false)
  const folded = options.length > 3 && !showAllOptions
  const visibleOptions = folded ? options.slice(0, 1) : options

  return (
    <section
      data-testid="checkpoint-controls"
      className={`flex flex-col gap-2.5 rounded-lg border bg-surface p-3 ${externalWork ? 'border-running/45' : 'border-warning/45'} ${STAGE_COLUMN}`}
    >
      <div className="flex items-center gap-2">
        {externalWork
          ? <StatusDot state="running" className="shrink-0" />
          : <span aria-hidden="true" className="text-warning">⏸</span>}
        <span
          data-testid="checkpoint-title"
          className="text-[12.5px] font-semibold"
        >
          {checkpointTitle(checkpoint.kind)}
        </span>
      </div>
      {/* The hand-off's `message` is written AT the agent holding the step
          ("Run this scout step in your own client…") — the wrong reader. The
          stage's own state line above already says what is happening here. */}
      {!externalWork && <p className="text-[12px] text-secondary">{checkpoint.message}</p>}
      {staleSubmission && (
        <p data-testid="checkpoint-stale-submission" className="text-[11px] text-warning">
          {EXTERNAL_WORK_COPY.lateResultNote}
        </p>
      )}

      {checkpoint.kind === 'config-approval' && configError && (
        <p data-testid="checkpoint-config-error" className="text-[11px] text-danger font-mono">
          {configError}
        </p>
      )}

      {/* Same renderer as the Portify wizard's review screen — the checkpoint
          shows the identical captured patch, so it gets the identical
          per-line-coloured diff block, not a plain wall of text. */}
      {diff && <DiffView diff={diff} />}

      {checkpoint.kind === 'missing-env' && !readOnly && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-muted">
            Missing: {missing.join(', ')}
          </div>
          <textarea
            data-testid="checkpoint-env-values"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'KEY=value\nANOTHER_KEY=value'}
            spellCheck={false}
            rows={4}
            className="cl-input w-full p-2 text-[11px] font-mono"
          />
          <button
            type="button"
            data-testid="checkpoint-submit-values"
            disabled={busy || !envText.trim()}
            onClick={() => {
              const values: Record<string, string> = {}
              for (const line of envText.split('\n')) {
                const eq = line.indexOf('=')
                if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
              }
              respond({ values })
            }}
            className="cl-button self-start px-2.5 py-1 text-xs"
          >
            Save these settings
          </button>
        </div>
      )}

      {readOnly && (
        <p data-testid="checkpoint-read-only" className="text-[11px] text-secondary">
          {EXTERNAL_DRIVE_COPY.checkpointLine}
        </p>
      )}
      {!readOnly && (
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleOptions.map((option, i) => (
          <button
            key={option}
            type="button"
            data-testid={`checkpoint-choice-${option}`}
            disabled={busy}
            onClick={() => (option === 'revise'
              ? setReviseOpen((v) => !v)
              : respond({ choice: option, ...(option === 'submit' && handOffId ? { token: handOffId } : {}) }))}
            className="cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            style={i === 0 && !externalWork
              ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
              : undefined}
          >
            {checkpointOptionLabel(checkpoint.kind, option)}
            {i === 0 && !externalWork && (
              /* R71/W3: the default is named, not color-only. */
              <span
                data-testid="checkpoint-recommended"
                className="cl-badge-accent"
              >
                Recommended
              </span>
            )}
          </button>
        ))}
        {folded && (
          <button
            type="button"
            data-testid="checkpoint-more-options"
            disabled={busy}
            onClick={() => setShowAllOptions(true)}
            className="cl-button px-2.5 py-1 text-xs text-muted"
          >
            More options ▾
          </button>
        )}
      </div>
      )}

      {reviseOpen && (
        <div className="flex flex-col gap-1.5">
          <textarea
            data-testid="checkpoint-revise-feedback"
            value={reviseText}
            onChange={(e) => setReviseText(e.target.value)}
            placeholder="What should the agent change? It starts two copies again to re-check."
            spellCheck={false}
            rows={3}
            className="cl-input w-full p-2 text-[11px] font-mono"
          />
          <button
            type="button"
            data-testid="checkpoint-revise-submit"
            disabled={busy || !reviseText.trim()}
            onClick={() => respond({ choice: 'revise', feedback: reviseText.trim() })}
            className="cl-button self-start px-2.5 py-1 text-xs"
          >
            Send feedback
          </button>
        </div>
      )}

      {failure && <div className="text-[11px] text-danger">{failure}</div>}
    </section>
  )
}
