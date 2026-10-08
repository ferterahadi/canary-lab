import type { PlaybackIdentity } from '@shared/playback-identity'
import { shortSourceLocation } from '@shared/lib/source-location'
import { formatLocalDateTime, shortTime } from '@/shared/lib/format'
import { useNow } from '@/shared/state/use-now'
import type { PlaywrightArtifactGroup, PlaywrightPlaybackEvent, RunSummary } from '@shared/run-detail'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { RunLifecycleEvent } from '@shared/run-state'
import type { VerificationDiagnostics } from '@shared/verification'
import { isTerminalLifecyclePhase, type TimelineRow } from '../utils/run-timeline'
import { PaneTerminal } from './PaneTerminal'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { RunPane } from './RunPane'
import { PlaywrightPlayback, PlaywrightView, formatSummaryTestName, isPlaywrightLifecyclePhase } from './RunPlaybackPanels'
import { Tab } from '@/shared/ui/Tab'

export function PlaywrightPanel({
  runId,
  view,
  onViewChange,
  events,
  playbackIdentity,
  artifactGroups,
  artifactPolicy,
  onOpenArtifactSettings,
  summary,
  diagnostics,
  totalTests,
  focusTest,
  focusTestId,
  focusTestLocation,
}: {
  runId: string
  view: PlaywrightView
  onViewChange: (view: PlaywrightView) => void
  events?: PlaywrightPlaybackEvent[]
  playbackIdentity?: PlaybackIdentity
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
  summary?: RunSummary
  diagnostics?: VerificationDiagnostics
  totalTests?: number
  /** R82: forwarded to the playback list, which scrolls this test into view. */
  focusTest?: string
  focusTestId?: string
  focusTestLocation?: string
}) {
  return (
    <RunPane
      scroll={false}
      bar={
        <>
          {/* Same face as the run's primary tabs — it is sub-navigation, so it
              should look like navigation. */}
          <Tab active={view === 'playback'} onClick={() => onViewChange('playback')} className="shrink-0 whitespace-nowrap">Playback</Tab>
          <Tab active={view === 'terminal'} onClick={() => onViewChange('terminal')} className="shrink-0 whitespace-nowrap">Terminal</Tab>
          {/* One artifact-policy control for the whole pane. It used to repeat
              on every playback card, which read as a per-test setting — it is
              a per-feature one. */}
          {onOpenArtifactSettings && (
            <>
              <div className="min-w-2 flex-1" />
              {/* Reads as a control, not a caption: bordered, gear-marked, and
                  it lifts on hover. As bare muted text it was indistinguishable
                  from the labels around it. */}
              <button
                type="button"
                onClick={onOpenArtifactSettings}
                title="Choose which Playwright artifacts this suite keeps — screenshots, video, trace"
                className="cl-button mb-1 inline-flex shrink-0 items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
              >
                <GearIcon />
                Artifact settings
              </button>
            </>
          )}
        </>
      }
    >
      {view === 'terminal' && (
        <PaneTerminal
          runId={runId}
          paneId="playwright"
          emptyState={{ idle: EMPTY_COPY.panePlaywrightIdle, missing: EMPTY_COPY.panePlaywrightMissing }}
        />
      )}
      {view === 'playback' && (
        <div className="h-full overflow-y-auto scrollbar-thin" style={{ background: 'var(--bg-base)' }}>
          {diagnostics && <VerificationDiagnosticsPanel diagnostics={diagnostics} />}
          <PlaywrightPlayback events={events} playbackIdentity={playbackIdentity} artifactGroups={artifactGroups} artifactPolicy={artifactPolicy} summary={summary} totalTests={totalTests} {...(focusTest ? { focusTest, focusTestId, focusTestLocation } : {})} embedded />
        </div>
      )}
    </RunPane>
  )
}

function GearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.64.73.83.3.17.63.26.97.26H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
                {test.testFile && <span>{shortSourceLocation(test.testFile)}</span>}
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
      {/* One connected rail: a hairline runs behind the dots so the rows read
          as one sequence, and each dot is ringed in the pane's own colour so
          the line breaks around it instead of striking through. Four fixed
          columns — dot, time, body, duration — so headlines start on one edge,
          durations end on the other, and a long detail wraps inside the body
          column instead of running under the durations. */}
      <ol className="relative space-y-2.5">
        {rows.length > 1 && (
          <span aria-hidden="true" className="absolute bottom-2 left-[3.5px] top-2 w-px" style={{ background: 'var(--border-default)' }} />
        )}
        {rows.map((row) => {
          const event = row.event
          const showRunningTest = row.isLastEngine && summary?.running && event != null && isPlaywrightLifecyclePhase(event.phase)
          return (
            <li key={row.key} className="grid grid-cols-[8px_52px_minmax(0,1fr)_72px] items-baseline gap-x-2 text-xs">
              <span className={`relative mt-1.5 h-2 w-2 self-start rounded-full ring-2 ring-[var(--bg-base)] ${dotClass(row.severity)}`} />
              <time
                className="tabular-nums text-[10px]"
                dateTime={row.ts}
                title={formatLocalDateTime(row.ts)}
                style={{ color: 'var(--text-muted)' }}
              >
                {shortTime(row.ts)}
              </time>
              <span className="min-w-0">
                <span className="block truncate" style={{ color: 'var(--text-primary)' }}>{row.headline}</span>
                {(row.clientLabel || row.detail) && (
                  <span className="mt-0.5 block break-words" style={{ color: 'var(--text-muted)' }}>
                    {row.clientLabel && (
                      <span style={{ color: 'var(--text-secondary)' }}>{row.clientLabel}</span>
                    )}
                    {row.clientLabel && row.detail ? ' · ' : ''}
                    {row.detail}
                  </span>
                )}
                {showRunningTest && summary?.running && (
                  <span className="mt-0.5 block break-words" style={{ color: 'var(--text-muted)' }}>
                    Now running: {formatSummaryTestName(summary.running.name)}
                    {summary.running.step?.location
                      ? ` · ${shortSourceLocation(summary.running.step.location)}`
                      : summary.running.location
                        ? ` · ${shortSourceLocation(summary.running.location)}`
                        : ''}
                  </span>
                )}
                {event?.restartPlan && (
                  <span className="mt-0.5 block break-words" style={{ color: 'var(--text-muted)' }}>{formatRestartPlan(event.restartPlan)}</span>
                )}
                {event?.targetedRerun && (
                  <span className="mt-0.5 block" style={{ color: 'var(--text-muted)' }}>
                    {event.targetedRerun.selected}/{event.targetedRerun.total} selected
                  </span>
                )}
              </span>
              <span className="text-right tabular-nums text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {row.durationLabel}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function useTimelineNow(events: RunLifecycleEvent[]): number {
  const lastPhase = events.at(-1)?.phase
  const lastUpdatedAt = events.at(-1)?.updatedAt
  const tick = Boolean(lastPhase && !isTerminalLifecyclePhase(lastPhase))

  return useNow({ enabled: tick, intervalMs: 30_000, resetKey: lastUpdatedAt, refreshOnReset: true })
}

export function formatLifecycleDate(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(time))
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
