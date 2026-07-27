import { useEffect, useState } from 'react'
import type { PlaywrightArtifactGroup, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent, RunLifecycleEvent, RunSummary, VerificationDiagnostics } from '@/shared/api/types'
import { isTerminalLifecyclePhase, type TimelineRow } from '../utils/run-timeline'
import { PaneTerminal } from './PaneTerminal'
import { PlaywrightPlayback, PlaywrightView, SegmentButton, formatSummaryTestName, isPlaywrightLifecyclePhase, shortLocation } from './RunPlaybackPanels'

export function PlaywrightPanel({
  runId,
  view,
  onViewChange,
  events,
  artifactGroups,
  artifactPolicy,
  onOpenArtifactSettings,
  summary,
  diagnostics,
  totalTests,
  focusTest,
}: {
  runId: string
  view: PlaywrightView
  onViewChange: (view: PlaywrightView) => void
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
  summary?: RunSummary
  diagnostics?: VerificationDiagnostics
  totalTests?: number
  /** R82: forwarded to the playback list, which scrolls this test into view. */
  focusTest?: string
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="cl-panel-header flex gap-1 px-3 py-1.5 text-xs">
        <SegmentButton active={view === 'terminal'} onClick={() => onViewChange('terminal')}>Terminal</SegmentButton>
        <SegmentButton active={view === 'playback'} onClick={() => onViewChange('playback')}>Playback</SegmentButton>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'terminal' && (
          <PaneTerminal
            runId={runId}
            paneId="playwright"
            emptyState={{ title: 'Playwright', hint: 'Test output appears here once Playwright starts running.' }}
          />
        )}
        {view === 'playback' && (
          <div className="h-full overflow-y-auto scrollbar-thin" style={{ background: 'var(--bg-base)' }}>
            {diagnostics && <VerificationDiagnosticsPanel diagnostics={diagnostics} />}
            <PlaywrightPlayback events={events} artifactGroups={artifactGroups} artifactPolicy={artifactPolicy} onOpenArtifactSettings={onOpenArtifactSettings} summary={summary} totalTests={totalTests} {...(focusTest ? { focusTest } : {})} embedded />
          </div>
        )}
      </div>
    </div>
  )
}

export function VerificationDiagnosticsPanel({ diagnostics }: { diagnostics: VerificationDiagnostics }) {
  return (
    <div className="border-b p-3 text-xs" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}>
      <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
        {diagnostics.summary} Verify does not edit code or start a heal cycle.
      </div>
      {diagnostics.failedTests.length > 0 && (
        <div className="space-y-2">
          {diagnostics.failedTests.map((test) => (
            <div key={`${test.name}:${test.location ?? ''}`} className="rounded-md border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{test.name}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {test.testFile && <span>{shortLocation(test.testFile)}</span>}
                {test.targetUrl && <span>{test.targetUrl}</span>}
                {test.endpoint && <span>{test.endpoint}</span>}
                {typeof test.httpStatus === 'number' && <span>HTTP {test.httpStatus}</span>}
              </div>
              {test.errorMessage && (
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md p-2 scrollbar-thin" style={{ background: 'var(--bg-selected)', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
                  {test.errorMessage}
                </pre>
              )}
              {(test.networkErrors?.length || test.consoleErrors?.length) && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {test.networkErrors?.length ? <DiagnosticList title="Network" lines={test.networkErrors} /> : null}
                  {test.consoleErrors?.length ? <DiagnosticList title="Console" lines={test.consoleErrors} /> : null}
                </div>
              )}
              {test.artifacts?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {test.artifacts.map((artifact) => (
                    <a
                      key={`${artifact.kind}:${artifact.url}`}
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded px-2 py-1 text-[11px] font-medium"
                      style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
                    >
                      {artifact.kind}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function DiagnosticList({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md p-2" style={{ background: 'var(--bg-selected)' }}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</div>
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap scrollbar-thin" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
        {lines.join('\n')}
      </pre>
    </div>
  )
}

export function RecoveryTimeline({
  rows,
  alert,
  summary,
}: {
  rows: TimelineRow[]
  alert?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }
  summary?: RunSummary
}) {
  return (
    <div>
      {alert && (
        <div className={`mb-2 rounded-md border px-2.5 py-2 text-xs ${alertClass(alert.tone)}`}>
          {alert.message}
        </div>
      )}
      <ol className="space-y-2">
        {rows.map((row) => {
          const event = row.event
          const showRunningTest = row.isLastEngine && summary?.running && event != null && isPlaywrightLifecyclePhase(event.phase)
          return (
            <li key={row.key} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2 text-xs">
              <span className={`mt-1.5 h-2 w-2 rounded-full ${dotClass(row.severity)}`} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  <time
                    className="shrink-0 tabular-nums text-[10px]"
                    dateTime={row.ts}
                    title={formatLifecycleDateTime(row.ts)}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {formatLifecycleTime(row.ts)}
                  </time>
                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{row.headline}</span>
                  {row.durationLabel && (
                    <span className="shrink-0 tabular-nums text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {row.durationLabel}
                    </span>
                  )}
                </span>
                {(row.clientLabel || row.detail) && (
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    {row.clientLabel && (
                      <span style={{ color: 'var(--text-secondary)' }}>{row.clientLabel}</span>
                    )}
                    {row.clientLabel && row.detail ? ' · ' : ''}
                    {row.detail}
                  </span>
                )}
                {showRunningTest && summary?.running && (
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    Now running: {formatSummaryTestName(summary.running.name)}
                    {summary.running.step?.location
                      ? ` · ${shortLocation(summary.running.step.location)}`
                      : summary.running.location
                        ? ` · ${shortLocation(summary.running.location)}`
                        : ''}
                  </span>
                )}
                {event?.restartPlan && (
                  <span className="block" style={{ color: 'var(--text-muted)' }}>{formatRestartPlan(event.restartPlan)}</span>
                )}
                {event?.targetedRerun && (
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    {event.targetedRerun.selected}/{event.targetedRerun.total} selected
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function useTimelineNow(events: RunLifecycleEvent[]): number {
  const [now, setNow] = useState(() => Date.now())
  const lastPhase = events.at(-1)?.phase
  const lastUpdatedAt = events.at(-1)?.updatedAt
  const tick = Boolean(lastPhase && !isTerminalLifecyclePhase(lastPhase))

  useEffect(() => {
    setNow(Date.now())
    if (!tick) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [tick, lastUpdatedAt])

  return now
}

export function formatLifecycleTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(time))
}

export function formatLifecycleDateTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(time))
}

export function alertClass(tone: 'info' | 'success' | 'warning' | 'error'): string {
  if (tone === 'success') return 'border-success/40 bg-success/10 text-success'
  if (tone === 'warning') return 'border-warning/40 bg-warning/10 text-warning'
  if (tone === 'error') return 'border-danger/40 bg-danger/10 text-danger'
  return 'border-running/40 bg-running/10 text-running'
}

export function dotClass(severity: RunLifecycleEvent['severity']): string {
  if (severity === 'success') return 'bg-success'
  if (severity === 'warning') return 'bg-warning'
  if (severity === 'error') return 'bg-danger'
  return 'bg-running'
}

export function formatRestartPlan(plan: NonNullable<RunLifecycleEvent['restartPlan']>): string {
  const parts: string[] = []
  if (plan.restarted.length > 0) parts.push(`restarted ${plan.restarted.join(', ')}`)
  if (plan.kept.length > 0) parts.push(`kept ${plan.kept.join(', ')}`)
  if ((plan.startedBecauseMissing ?? []).length > 0) parts.push(`started missing ${(plan.startedBecauseMissing ?? []).join(', ')}`)
  return parts.join('; ')
}
