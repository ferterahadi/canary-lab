import { useEffect, useState } from 'react'
import type { FlightManifest, FlightStageKey } from '@/shared/api/client'
import { formatDuration, num, specsCoverageProgress, stageStatusTone, type StageFact } from './stage-meta'
import { asRecord } from './StageDetail'

/** The header's summary strip (R61, R71/W5): the flight's headline numbers —
 *  elapsed wall-clock (live 1s tick while running), coverage %, run verdict,
 *  doc count, report readiness — derived from the manifest; items that don't
 *  exist yet simply don't render. Each stage-backed item is a jump: clicking
 *  Coverage/Run/Docs/Report selects that stage in the rail. */
export function FlightSummaryStrip({
  flight,
  derived,
  onSelectStage,
  onToggleAutopilot,
  autopilotLockedReason,
}: {
  flight: FlightManifest
  /** R81: rendering a pseudo-manifest — suppress facts that only a real record
   *  can honestly answer. */
  derived?: boolean
  onSelectStage?: (key: FlightStageKey) => void
  /** R78: autopilot is a preference the user flips whenever they want, not a
   *  start-time-only option — so it reads and toggles from the facts strip. */
  onToggleAutopilot?: (next: boolean) => void
  /** Non-null → the toggle renders inert with this as its tooltip. Set while
   *  an MCP client is driving the flight: autopilot decides checkpoints, so
   *  flipping it changes what that client's flight answers for itself. The
   *  toggle stays VISIBLE because its current value is information the reader
   *  still wants; only the flip is withheld. */
  autopilotLockedReason?: string
}) {
  const items: Array<{ label: string; value: string; tone?: string; stage?: FlightStageKey }> = []

  // R71/W5: the one state where you'd watch the clock used to be the one state
  // that hid it — tick locally while the flight runs.
  const live = !flight.endedAt && flight.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  const elapsed = formatDuration(flight.createdAt, flight.endedAt ?? (live ? new Date(now).toISOString() : flight.updatedAt))
  if (elapsed) {
    items.push({ label: flight.endedAt ? 'Elapsed' : 'Elapsed so far', value: elapsed })
  }

  // R79: which CLI conducts this flight's stage agents — read-only (chosen at
  // start, sticky for the record's life), shown as a plain fact so the user
  // always knows without a control they can't change here. R81: a derived
  // flight has no conductor and no stored choice, so naming one would be a
  // fabrication — the agent is picked in the launcher if it's ever conducted.
  if (!derived) items.push({ label: 'Agent', value: flight.opts.agent ?? 'claude' })

  // Coverage came only from the authoring LOOP's pass records, which just one
  // population ever has: a flight that conducted specs-coverage itself. A
  // derived flight, and any flight resumed past that step, carries the stage as
  // done with no passes — so the strip printed no coverage at all while the
  // stage one click away reported it off the ledger. The stage's own evidence
  // holds the same percentage (the conducted adapter and the read-time probe
  // both write `coveragePct`), so it stands in when there is no loop to read.
  const specs = flight.stages.find((s) => s.key === 'specs-coverage')
  const lastMapped = specsCoverageProgress(specs)?.passes.filter((p) => p.note == null).at(-1)
  const settledPct = num(asRecord(specs?.evidence) ?? {}, 'coveragePct')
  const coveragePct = lastMapped?.coveragePct ?? settledPct
  if (coveragePct != null) {
    items.push({
      label: 'Coverage',
      value: `${coveragePct}%`,
      // Gaps open is what the loop reports; without it, a full 100% is the same
      // statement — every requirement claimed by some spec.
      tone: (lastMapped ? lastMapped.gapsOpen === 0 : coveragePct >= 100) ? 'var(--success)' : 'var(--warning)',
      stage: 'specs-coverage',
    })
  }

  if (flight.runVerdict) {
    items.push({
      label: 'Run',
      value: flight.runVerdict,
      tone: flight.runVerdict === 'passed' ? 'var(--success)' : flight.runVerdict === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
      stage: 'run',
    })
  }

  const docsEv = asRecord(flight.stages.find((s) => s.key === 'docs')?.evidence)
  const docs = Array.isArray(docsEv?.docs) ? docsEv.docs.length : 0
  if (docs > 0) items.push({ label: 'Docs', value: String(docs), stage: 'docs' })

  if (flight.links?.evaluationZip) items.push({ label: 'Report', value: 'ready', tone: 'var(--success)', stage: 'evaluation-export' })

  const autopilotOn = flight.opts.autopilot !== false
  const autopilotActive = autopilotOn && !flight.opts.yolo
  if (items.length === 0 && !onToggleAutopilot) return null
  return (
    <div
      data-testid="flight-summary-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-1.5 border-line"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {items.map((item) => {
          const body = (
            <>
              <span className="cl-rubric">
                {item.label}
              </span>
              {/* `tone` is a computed status token from stageStatusTone — the
                  one place a colour still arrives as a value, not a class. */}
              <span className="font-mono text-secondary" style={item.tone ? { color: item.tone } : undefined}>{item.value}</span>
            </>
          )
          return item.stage && onSelectStage ? (
            <button
              key={item.label}
              type="button"
              data-testid={`strip-${item.stage}`}
              onClick={() => onSelectStage(item.stage!)}
              className="flex items-baseline gap-1.5 rounded text-[11px] underline-offset-2 transition-colors hover:underline"
              title={`Jump to ${stageRailLabelFor(item.stage)}`}
            >
              {body}
            </button>
          ) : (
            <span key={item.label} data-testid="strip-elapsed" className="flex items-baseline gap-1.5 text-[11px]">
              {body}
            </span>
          )
        })}
      </div>
      {onToggleAutopilot && (
        <div className="ml-auto flex items-center gap-2 border-l border-line pl-3">
          <button
            type="button"
            data-testid="flight-autopilot-toggle"
            aria-pressed={autopilotOn}
            disabled={flight.opts.yolo || autopilotLockedReason != null}
            onClick={() => onToggleAutopilot(!autopilotOn)}
            className="group flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] outline-none transition-shadow duration-150 focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-default"
            title={autopilotLockedReason
              ? autopilotLockedReason
              : flight.opts.yolo
              ? 'This flight runs --yolo — every checkpoint except missing env is skipped, whatever autopilot says'
              : autopilotOn
                ? 'Autopilot answers the checkpoints with a safe default — click to be asked at every one from now on'
                : 'Every checkpoint parks for you — click to let the safe defaults answer again'}
          >
            <span className="cl-rubric">
              Autopilot
            </span>
            <span
              aria-hidden="true"
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-all duration-150 group-hover:brightness-110 group-active:brightness-90 group-disabled:opacity-60 ${autopilotActive ? 'border-accent bg-accent' : 'border-line bg-elevated'}`}
            >
              <span
                className="inline-block h-3 w-3 rounded-full bg-canvas transition-transform duration-150"
                style={{ boxShadow: 'var(--shadow-panel)', transform: autopilotOn ? 'translateX(13px)' : 'translateX(2px)' }}
              />
            </span>
            {/* Reserve the widest state word ('off') so toggling on↔off can't
                resize the group and slide the whole ml-auto cluster sideways. */}
            <span className={`inline-block min-w-[3ch] text-left font-mono ${autopilotOn ? 'text-secondary' : 'text-muted'}`}>
              {flight.opts.yolo ? 'yolo' : autopilotOn ? 'on' : 'off'}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

/** The rail row label a strip jump lands on (merged-pair aware). */
export function stageRailLabelFor(key: FlightStageKey): string {
  if (key === 'run') return 'Test Run'
  if (key === 'docs') return 'Requirements'
  return key === 'specs-coverage' ? 'Test authoring & coverage' : 'Evaluation Report'
}

/** Distill the parsed feature.config + playwright.config into fact rows. Pure
 *  and defensive: config ASTs carry `$expr` stand-ins and hand-edited shapes —
 *  anything unreadable simply doesn't produce a row. */
export function configDigestFacts(config: unknown, playwright: unknown): StageFact[] {
  const facts: StageFact[] = []
  const repos = Array.isArray(asRecord(config)?.repos) ? (asRecord(config)!.repos as unknown[]) : []
  const repoNames: string[] = []
  const commands: Array<{ command: string; service: string; ports: string[] }> = []
  for (const r of repos) {
    const repo = asRecord(r)
    if (!repo) continue
    const name = typeof repo.name === 'string' ? repo.name : null
    const branch = typeof repo.branch === 'string' ? repo.branch : null
    if (name) repoNames.push(branch ? `${name} @ ${branch}` : name)
    const startCommands = Array.isArray(repo.startCommands) ? repo.startCommands : []
    for (const sc of startCommands) {
      const svc = asRecord(sc)
      if (!svc || typeof svc.command !== 'string') continue
      const ports = (Array.isArray(svc.ports) ? svc.ports : [])
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => p !== null)
        .map((p) => `${typeof p.name === 'string' ? p.name : '?'}${typeof p.env === 'string' ? ` (${p.env})` : ''}`)
      commands.push({ command: svc.command, service: typeof svc.name === 'string' ? svc.name : name ?? 'service', ports })
    }
  }
  if (repoNames.length > 0) facts.push({ label: 'Repos', value: repoNames.join(', '), mono: true })
  for (const c of commands) {
    facts.push({ label: commands.length === 1 ? 'Run command' : `Run · ${c.service}`, value: c.command, mono: true, title: c.service })
    if (c.ports.length > 0) facts.push({ label: 'Ports', value: c.ports.join(', '), mono: true })
  }
  const pw = asRecord(playwright)
  if (pw) {
    const use = asRecord(pw.use)
    const bits = [
      typeof pw.workers === 'number' ? `${pw.workers} worker${pw.workers === 1 ? '' : 's'}` : null,
      typeof pw.retries === 'number' ? `${pw.retries} retr${pw.retries === 1 ? 'y' : 'ies'}` : null,
      typeof use?.video === 'string' ? `video ${use.video}` : null,
      typeof use?.trace === 'string' ? `trace ${use.trace}` : null,
    ].filter(Boolean)
    if (bits.length > 0) facts.push({ label: 'Playwright', value: bits.join(' · ') })
  }
  return facts
}
