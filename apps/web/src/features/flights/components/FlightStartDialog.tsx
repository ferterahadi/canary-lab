import { useEffect, useMemo, useState } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightEntryOptions,
  FlightStageEntryOption,
  FlightStageKey,
  FlightStageStatus,
} from '../../../shared/api/client'
import { Modal, Textarea } from '../../config/components/atoms'
import { STAGE_ICON, STAGE_LABEL, stageStatusTone } from './stage-meta'

// R25: the UI's flight launcher. One dialog per feature that answers "where do
// you want the pipeline to (re)start?" — a stage menu in the rail's vocabulary,
// where each row's clickability is the SERVER's stage-entry verdict
// (GET /api/flights/entry), never a client-side prerequisite guess. Picking a
// row + Start posts the same /api/flights body the CLI and MCP send
// (four-surface parity), so continue / redo / jump behave identically here.

/** The pickable steps: stage keys minus `heal` (always run-driven — the server
 *  rejects it outright, so it isn't a choice) in execution order. `similarity`
 *  doubles as "the beginning": entering there is a full flight (mode `redo`
 *  when a record exists). */
const PICKABLE: FlightStageKey[] = [
  'similarity',
  'scout',
  'scaffold',
  'env-capture',
  'docs',
  'prd-summary',
  'specs-coverage',
  'portify',
  'run',
  'evaluation-export',
]

function rowLabel(key: FlightStageKey): string {
  return key === 'similarity' ? 'Full flight — from the beginning' : STAGE_LABEL[key]
}

export function FlightStartDialog({
  feature,
  onClose,
  onOpenFlight,
}: {
  feature: string
  onClose: () => void
  /** Navigate to the flight detail view (just-started or already-active). */
  onOpenFlight: (flightId: string) => void
}) {
  const [entry, setEntry] = useState<FlightEntryOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<FlightStageKey | 'continue' | null>(null)
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.getFlightEntryOptions(feature)
      .then((options) => {
        if (!alive) return
        setEntry(options)
        setDescription(options.prefill.description)
        setPicked(options.canContinue ? 'continue' : null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [feature])

  const byKey = useMemo(() => {
    const map = new Map<FlightStageKey, FlightStageEntryOption>()
    for (const s of entry?.stages ?? []) map.set(s.key, s)
    return map
  }, [entry])
  const lastStatus = useMemo(() => {
    const map = new Map<FlightStageKey, FlightStageStatus>()
    for (const s of entry?.flight?.stages ?? []) map.set(s.key, s.status)
    return map
  }, [entry])

  const canSubmit =
    entry !== null
    && !entry.active
    && !busy
    && picked !== null
    && description.trim() !== ''
    && entry.prefill.repoPaths.length > 0

  const start = (): void => {
    if (!entry || picked === null) return
    setBusy(true)
    setStartError(null)
    const hasRecord = entry.flight !== null
    const body: api.StartFlightBody = {
      feature,
      repoPaths: entry.prefill.repoPaths,
      description: description.trim(),
      env: entry.prefill.env,
      coverageTarget: entry.prefill.coverageTarget,
      ...(picked === 'continue'
        ? { mode: 'continue' as const }
        : picked === 'similarity'
          ? (hasRecord ? { mode: 'redo' as const } : {})
          : { ...(hasRecord ? { mode: 'jump' as const } : {}), fromStage: picked }),
    }
    api.startFlight(body)
      .then((manifest) => onOpenFlight(manifest.flightId))
      .catch((err: unknown) => {
        const body = err instanceof api.ApiError ? (err.body as { error?: string } | null) : null
        setStartError(body?.error ?? (err instanceof Error ? err.message : String(err)))
        setBusy(false)
      })
  }

  return (
    <Modal open onClose={onClose} eyebrow="Flight" title={feature} width={520}>
      <div className="flex flex-col gap-3 p-4">
        {loadError ? (
          <div data-testid="flight-start-error" className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
            {loadError}
          </div>
        ) : !entry ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading stage options…</div>
        ) : entry.active ? (
          // Attach, never a second start: the single-flight lock holds server-side.
          <div className="flex flex-col gap-2">
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              This feature is flying right now.
            </div>
            <button
              type="button"
              data-testid="flight-start-open-active"
              onClick={() => onOpenFlight(entry.flight!.flightId)}
              className="cl-button self-start px-2.5 py-1 text-xs"
              style={{ color: 'rgb(56, 189, 248)' }}
            >
              Open the running flight →
            </button>
          </div>
        ) : (
          <>
            <div className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {entry.prefill.repoPaths.join(', ')}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                What to test
              </span>
              <Textarea
                value={description}
                onChange={setDescription}
                minRows={2}
                maxRows={4}
                placeholder="e.g. the checkout flow end to end"
              />
            </label>

            <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Start from">
              <span className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Start from
              </span>

              {entry.canContinue && (
                <StageRow
                  testId="flight-start-continue"
                  selected={picked === 'continue'}
                  onPick={() => setPicked('continue')}
                  icon="▸"
                  iconTone="rgb(56, 189, 248)"
                  label="Continue where it left off"
                  sub="Resumes the paused flight at its first open stage."
                />
              )}

              {PICKABLE.map((key) => {
                const verdict = byKey.get(key)
                const allowed = verdict?.allowed ?? false
                const status = key === 'similarity' ? undefined : lastStatus.get(key)
                return (
                  <StageRow
                    key={key}
                    testId={`flight-start-stage-${key}`}
                    selected={picked === key}
                    disabled={!allowed}
                    onPick={() => setPicked(key)}
                    icon={status ? STAGE_ICON[status] : '·'}
                    iconTone={stageStatusTone(status)}
                    label={rowLabel(key)}
                    sub={allowed ? undefined : verdict?.reason}
                  />
                )
              })}
            </div>

            {entry.flight !== null && (
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Starting resets this flight's stage records; captured artifacts on
                disk (config, envset, docs, specs) are kept and reused.
              </div>
            )}

            {startError && (
              <div data-testid="flight-start-error" className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
                {startError}
              </div>
            )}

            <div className="flex items-center justify-end gap-1.5">
              <button type="button" onClick={onClose} className="cl-button px-2.5 py-1 text-xs">Cancel</button>
              <button
                type="button"
                data-testid="flight-start-submit"
                disabled={!canSubmit}
                onClick={start}
                className="cl-button px-2.5 py-1 text-xs"
                style={{ color: canSubmit ? 'rgb(56, 189, 248)' : undefined, opacity: canSubmit ? 1 : 0.55 }}
              >
                {busy ? 'Starting…' : picked === 'continue' ? 'Continue flight' : 'Start flight'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** One pickable step. Disabled rows stay visible and say WHY they're blocked
 *  (the server's missing-prerequisite message) — never silently unclickable. */
function StageRow({
  testId,
  selected,
  disabled,
  onPick,
  icon,
  iconTone,
  label,
  sub,
}: {
  testId: string
  selected: boolean
  disabled?: boolean
  onPick: () => void
  icon: string
  iconTone: string
  label: string
  sub?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      disabled={disabled}
      onClick={onPick}
      className="flex items-start gap-2 rounded px-2 py-1.5 text-left transition-colors enabled:hover:bg-white/[0.04]"
      style={{
        background: selected ? 'var(--bg-selected)' : undefined,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : undefined,
      }}
    >
      <span className="w-3 shrink-0 text-center text-[12px] font-semibold" style={{ color: iconTone }} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]" style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {label}
        </span>
        {sub && (
          <span className="block text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {sub}
          </span>
        )}
      </span>
    </button>
  )
}
