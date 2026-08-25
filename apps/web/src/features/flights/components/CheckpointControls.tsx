import { useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightCheckpoint, FlightManifest, FlightStage } from '@/shared/api/client'
import { evaluationArchiveFilename } from '@/shared/lib/format'
import { DiffView } from '@/shared/ui/DiffView'
import { useEvaluationExports } from '@/features/evaluation'
import { checkpointOptionLabel, checkpointTitle, evaluationTaskId, STAGE_COLUMN } from './stage-meta'
import { externalMutationTooltip, isExternallyDriven } from '../lib/external-work'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'

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
  // opens this composer instead of responding immediately. An external owner
  // leaves that button visible but disabled, so the composer cannot open.
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseText, setReviseText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const mutate = (call: () => Promise<unknown>): void => {
    setBusy(true)
    setFailure(null)
    call()
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const respond = (response: { choice?: string; values?: Record<string, string>; data?: unknown; feedback?: string; token?: string }): void => {
    mutate(() => api.respondFlightCheckpoint(flightId, response))
  }

  const data = (checkpoint.data ?? {}) as Record<string, unknown>
  const missing = Array.isArray(data.missing) ? (data.missing as string[]) : []
  const diff = typeof data.diff === 'string' ? data.diff : null
  const configError = typeof data.error === 'string' ? data.error : null

  // A genuine question on an externally driven flight still belongs to the MCP
  // client that started it. The external-work hand-off itself never reaches
  // this component: running work lives in StageActivity, not in a decision card.
  const readOnly = isExternallyDriven(flight)
  const lockedTitle = readOnly
    ? externalMutationTooltip('flight', 'answer this checkpoint')
    : undefined

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
      className={`flex flex-col gap-2.5 rounded-lg border border-warning/45 bg-surface p-3 ${STAGE_COLUMN}`}
      >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-warning">⏸</span>
        <span
          data-testid="checkpoint-title"
          className="text-[12.5px] font-semibold"
        >
          {checkpointTitle(checkpoint.kind)}
        </span>
      </div>
      <p className="text-[12px] text-secondary">
        {checkpoint.message}
      </p>

      {checkpoint.kind === 'config-approval' && configError && (
        <p data-testid="checkpoint-config-error" className="text-[11px] text-danger font-mono">
          {configError}
        </p>
      )}

      {/* Same renderer as the Portify wizard's review screen — the checkpoint
          shows the identical captured patch, so it gets the identical
          per-line-coloured diff block, not a plain wall of text. */}
      {diff && <DiffView diff={diff} />}

      {checkpoint.kind === 'missing-env' && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-muted">
            Missing: {missing.join(', ')}
          </div>
          <DisabledControlTooltip wrapperClassName="flex w-full">
            <textarea
              data-testid="checkpoint-env-values"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'KEY=value\nANOTHER_KEY=value'}
              spellCheck={false}
              rows={4}
              disabled={readOnly}
              title={lockedTitle}
              className="cl-input w-full p-2 text-[11px] font-mono disabled:cursor-not-allowed disabled:opacity-45"
            />
          </DisabledControlTooltip>
          <DisabledControlTooltip wrapperClassName="inline-flex self-start">
            <button
              type="button"
              data-testid="checkpoint-submit-values"
              disabled={readOnly || busy || !envText.trim()}
              title={lockedTitle}
              onClick={() => {
                const values: Record<string, string> = {}
                for (const line of envText.split('\n')) {
                  const eq = line.indexOf('=')
                  if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
                }
                respond({ values })
              }}
              className="cl-button self-start px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
            >
              Save these settings
            </button>
          </DisabledControlTooltip>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {visibleOptions.map((option, i) => (
          <DisabledControlTooltip key={option}>
            <button
              type="button"
              data-testid={`checkpoint-choice-${option}`}
              disabled={readOnly || busy}
              title={lockedTitle}
              onClick={() => (option === 'revise'
                ? setReviseOpen((v) => !v)
                : respond({ choice: option }))}
              className="cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
              style={i === 0
                ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
                : undefined}
            >
              {checkpointOptionLabel(checkpoint.kind, option)}
              {i === 0 && (
                /* R71/W3: the default is named, not color-only. */
                <span
                  data-testid="checkpoint-recommended"
                  className="cl-badge-accent"
                >
                  Recommended
                </span>
              )}
            </button>
          </DisabledControlTooltip>
        ))}
        {folded && (
          <DisabledControlTooltip>
            <button
              type="button"
              data-testid="checkpoint-more-options"
              disabled={readOnly || busy}
              title={lockedTitle}
              onClick={() => setShowAllOptions(true)}
              className="cl-button px-2.5 py-1 text-xs text-muted disabled:cursor-not-allowed disabled:opacity-45"
            >
              More options ▾
            </button>
          </DisabledControlTooltip>
        )}
      </div>

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
