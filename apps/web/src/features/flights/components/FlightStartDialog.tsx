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
import { RepoMultiPicker, type RepoOption } from './RepoMultiPicker'

// R25/R40: the UI's flight launcher — THE entry point for flights.
// Two modes off one dialog:
//   • new-flight (feature == null, opened from "+ New"): asks exactly two
//     things — intent + repo list (RepoMultiPicker); the feature name derives
//     from the first repo (the CLI's slug rule); the Start-from menu renders
//     fully locked ("unlocks after the first flight" — R41).
//   • feature-scoped (existing behavior): the stage menu answers "where do you
//     want the pipeline to (re)start?", each row's clickability being the
//     SERVER's stage-entry verdict (GET /api/flights/entry), never a
//     client-side prerequisite guess.
// Picking + Start posts the same /api/flights body the CLI and MCP send
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

const FIRST_FLIGHT_REASON = "available after this feature's first flight"

export function FlightStartDialog({
  feature,
  knownRepos = [],
  onClose,
  onOpenFlight,
}: {
  /** Feature to (re)fly, or null → new-flight mode (intent + repo picker). */
  feature: string | null
  /** Known workspace repos (flattened from the features' configs) offered by
   *  the picker; free paths can always be added. */
  knownRepos?: RepoOption[]
  onClose: () => void
  /** Navigate to the flight detail view (just-started or already-active). */
  onOpenFlight: (flightId: string) => void
}) {
  const [entry, setEntry] = useState<FlightEntryOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [repoPaths, setRepoPaths] = useState<string[]>([])
  const [picked, setPicked] = useState<FlightStageKey | 'continue' | null>(feature ? null : 'similarity')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const newFlight = feature === null

  useEffect(() => {
    if (newFlight) return
    let alive = true
    api.getFlightEntryOptions(feature)
      .then((options) => {
        if (!alive) return
        setEntry(options)
        setDescription(options.prefill.description)
        setRepoPaths(options.prefill.repoPaths)
        setPicked(options.canContinue ? 'continue' : null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [feature, newFlight])

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

  const derivedFeature = newFlight && repoPaths.length > 0 ? api.deriveFeatureSlug(repoPaths[0]) : null

  // Repos are editable on a fresh start of a non-active flight (the server
  // resets downstream evidence on a repo change); locked mid-menu picks.
  const reposEditable = newFlight || (Boolean(entry?.editable?.repoPaths) && picked === 'similarity')

  const canSubmit = newFlight
    ? !busy && description.trim() !== '' && repoPaths.length > 0
    : entry !== null && !entry.active && !busy && picked !== null && description.trim() !== '' && repoPaths.length > 0

  const start = (): void => {
    if (busy) return
    setBusy(true)
    setStartError(null)
    const fail = (err: unknown): void => {
      const body = err instanceof api.ApiError ? (err.body as { error?: string } | null) : null
      setStartError(body?.error ?? (err instanceof Error ? err.message : String(err)))
      setBusy(false)
    }

    if (newFlight) {
      api.startFlight({
        feature: derivedFeature ?? 'feature',
        repoPaths,
        description: description.trim(),
      })
        .then((manifest) => onOpenFlight(manifest.flightId))
        .catch(fail)
      return
    }

    if (!entry || picked === null) return
    const hasRecord = entry.flight !== null
    const body: api.StartFlightBody = {
      feature: feature!,
      repoPaths,
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
      .catch(fail)
  }

  const stageMenu = (
    <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Start from">
      <span className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Start from
      </span>

      {!newFlight && entry?.canContinue && (
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
        // New flights always start from the beginning: the whole menu renders
        // visible-but-locked so the re-entry affordance is learnable (R41).
        const verdict = newFlight
          ? { key, allowed: key === 'similarity', reason: key === 'similarity' ? undefined : FIRST_FLIGHT_REASON }
          : byKey.get(key)
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
  )

  return (
    <Modal open onClose={onClose} eyebrow="Flight" title={feature ?? 'Start a flight'} width={520}>
      <div className="flex flex-col gap-3 p-4">
        {loadError ? (
          <div data-testid="flight-start-error" className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
            {loadError}
          </div>
        ) : !newFlight && !entry ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading stage options…</div>
        ) : !newFlight && entry?.active ? (
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
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                What should this flight test?
              </span>
              <Textarea
                value={description}
                onChange={setDescription}
                minRows={2}
                maxRows={4}
                placeholder="e.g. the checkout flow end to end — refer to ~/Documents/prd.md"
              />
            </label>
            <div className="-mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              Documents referenced here are linked into the flight automatically.
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Repos
              </span>
              <RepoMultiPicker
                known={knownRepos}
                selected={repoPaths}
                onChange={setRepoPaths}
                disabled={!reposEditable}
                disabledReason={
                  entry && !entry.editable?.repoPaths
                    ? 'Pause or stop the flight to change its repos.'
                    : 'Repos can change only on a full restart — pick "Full flight" to edit them.'
                }
              />
              {derivedFeature && (
                <div data-testid="flight-start-derived-feature" className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  Feature name: <span style={{ fontFamily: 'var(--font-mono)' }}>{derivedFeature}</span> — derived automatically
                </div>
              )}
            </div>

            {stageMenu}

            {newFlight ? (
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Step entry unlocks after this feature's first flight.
              </div>
            ) : entry?.flight !== null ? (
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Starting resets this flight's stage records; captured artifacts on
                disk (config, envset, docs, specs) are kept and reused.
              </div>
            ) : null}

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
