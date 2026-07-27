import { useEffect, useRef, useState } from 'react'
import type { PlaywrightArtifact, PlaywrightArtifactGroup, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent, RunLifecycleEvent, RunSummary } from '@/shared/api/types'
import { formatDuration } from '@/shared/lib/format'
import { artifactsForPlayback, playbackTests, type PlaybackTest } from '../utils/run-detail-playback'
import { statusFromPlaybackResult, statusLabel, statusPillClassForStatus } from '../utils/test-step-status'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { buildTestNumbering, parseLocation, stripLeadingTestOrdinal, testNumberKey } from '@/shared/test-numbering'
import { formatLifecycleTime } from './RunDiagnosticsPanels'

export type PlaywrightView = 'terminal' | 'playback'

export function SegmentButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`cl-tab shrink-0 whitespace-nowrap px-2.5 py-1 ${props.active ? 'cl-tab-active' : ''}`}
      style={{ color: props.active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
    >
      {props.children}
    </button>
  )
}

export function PlaywrightPlayback({
  events,
  artifactGroups,
  artifactPolicy,
  onOpenArtifactSettings,
  summary,
  totalTests,
  embedded = false,
  focusTest,
}: {
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
  summary?: RunSummary
  totalTests?: number
  embedded?: boolean
  /** R82: land on this test — matched against the playback test `name`, the same
   *  key `currentPlaybackIndex` compares against `summary.running`. An unknown
   *  name matches nothing and the list simply renders unscrolled. */
  focusTest?: string
}) {
  // Scroll the focused test into view once it exists. Keyed on the name (not a
  // mount-once effect) so clicking a SECOND failure while this list is already
  // open re-scrolls, and so the scroll still happens when playback events arrive
  // after the first render.
  const focusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!focusTest) return
    // `start`, not `center`: these cards run taller than the run-detail panel is
    // (error block + snippet + artifact sections), and centering a 265px card in a
    // ~200px panel scrolls its own title and status pill off the top — you land
    // mid-evidence with no idea which test you're looking at. Aligning the top
    // edge puts the header first, which is the point of landing here.
    focusRef.current?.scrollIntoView({ block: 'start' })
  }, [focusTest, events])

  const tests = playbackTests(events)
  if (tests.length === 0) {
    return <EmptyPane title="No playback events captured yet." body="Use Terminal for older runs or runs that ended before structured Playwright events were written." />
  }
  const activeIndex = currentPlaybackIndex(tests, summary?.running?.name)
  // Stable per-test ids, shared with the Tests column + Coverage Ledger. Number
  // against the run's full known set so a partial/targeted rerun keeps each
  // test's canonical id; fall back to the played-back tests when absent.
  const knownLocations = summary?.knownTests
    ?.map((t) => parseLocation(t.location))
    .filter((p): p is { file: string; line: number } => p !== null) ?? []
  const numberingSource = knownLocations.length > 0
    ? knownLocations
    : tests.map((t) => parseLocation(t.location)).filter((p): p is { file: string; line: number } => p !== null)
  const testNumbering = buildTestNumbering(numberingSource)
  return (
    <div className={`${embedded ? '' : 'h-full overflow-y-auto scrollbar-thin'} p-3 text-xs`} style={{ background: 'var(--bg-base)' }}>
      <div className="space-y-2">
        {tests.map((test, idx) => {
          const playbackArtifacts = artifactsForPlayback(test.name, artifactGroups, artifactPolicy)
          const traceArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'trace')
          const videoArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'video')
          const isCurrent = idx === activeIndex
          const isFocused = focusTest != null && test.name === focusTest
          return (
            <div
              key={`${test.name}:${test.retry ?? 0}:${test.startedAt ?? ''}`}
              {...(isFocused ? { 'data-focus-test': test.name } : {})}
              ref={isFocused ? focusRef : undefined}
              /* The landing marker: a left accent edge, not a wash — enough to
                 catch the eye after the scroll without recolouring the card. */
              className={`cl-card p-3${isFocused ? ' border-l-2 border-l-accent' : ''}`}
            >
              <div className="flex min-w-0 flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <PlaybackHeader
                    test={test}
                    current={isCurrent}
                    testNumber={(() => { const p = parseLocation(test.location); return p ? testNumbering.get(testNumberKey(p.file, p.line)) : undefined })()}
                  />
                </div>
                <TraceActions artifacts={traceArtifacts} />
              </div>
              {test.error?.message ? (
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md p-2 scrollbar-thin" style={{ background: 'var(--bg-selected)', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
                  {test.error.message}
                </pre>
              ) : (
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {isCurrent ? 'Currently executing in this Playwright process.' : test.passed === true ? 'Completed without a Playwright error.' : test.status ? `Status: ${test.status}` : 'Still running.'}
                </div>
              )}
              <ScreenshotPanel artifacts={playbackArtifacts.screenshots} mode={playbackArtifacts.screenshotMode} onOpenSettings={onOpenArtifactSettings} />
              <ArtifactActions artifacts={videoArtifacts} videoMode={artifactPolicy?.video ?? 'off'} onOpenSettings={onOpenArtifactSettings} />
              <BrowserActions steps={test.steps} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function TraceActions({ artifacts }: { artifacts: PlaywrightArtifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-2">
      {artifacts.map((artifact) => (
        <a
          key={artifact.path}
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          download={artifact.name}
          className="max-w-full truncate whitespace-nowrap rounded px-2.5 py-1 text-[11px] font-medium"
          style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
        >
          Download trace
        </a>
      ))}
    </div>
  )
}

export function PlaybackHeader({
  test,
  current,
  testNumber,
}: {
  test: PlaybackTest
  current: boolean
  testNumber?: number
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <StatusPill passed={test.passed} status={test.status} current={current} />
      <TestIdBadge n={testNumber} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate font-medium" style={{ color: 'var(--text-primary)' }} title={test.title}>
            {stripLeadingTestOrdinal(test.title)}
          </div>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {typeof test.durationMs === 'number' && <span>{formatDuration(test.durationMs)}</span>}
          {typeof test.retry === 'number' && test.retry > 0 && <span>retry {test.retry}</span>}
          {test.startedAt && <span>{formatLifecycleTime(test.startedAt)}</span>}
        </div>
      </div>
    </div>
  )
}

export function ScreenshotPanel({
  artifacts,
  mode,
  onOpenSettings,
}: {
  artifacts: PlaywrightArtifact[]
  mode: string
  onOpenSettings?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = mode === 'off'
    ? 'Disabled'
    : artifacts.length === 0
      ? 'No screenshot retained'
      : `${artifacts.length} retained`
  return (
    <EvidenceSection
      title="Screenshot"
      summary={summary}
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      onOpenSettings={onOpenSettings}
    >
      {mode === 'off' ? (
        <EmptyArtifactMessage>Screenshot disabled.</EmptyArtifactMessage>
      ) : artifacts.length === 0 ? (
        <EmptyArtifactMessage>No screenshot retained.</EmptyArtifactMessage>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {artifacts.map((artifact) => (
            <ScreenshotPreview key={artifact.path} artifact={artifact} />
          ))}
        </div>
      )}
    </EvidenceSection>
  )
}

export function ScreenshotPreview({ artifact }: { artifact: PlaywrightArtifact }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="overflow-hidden rounded-md" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-selected)' }}>
        <div className="px-3 py-8 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Screenshot could not be rendered.
        </div>
        <ArtifactCaption artifact={artifact} />
      </div>
    )
  }
  return (
    <a href={artifact.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
      <img
        src={artifact.url}
        alt="Final page screenshot"
        className="max-h-[520px] min-h-[220px] w-full object-contain"
        onError={() => setFailed(true)}
      />
      <ArtifactCaption artifact={artifact} />
    </a>
  )
}

export function ArtifactCaption({ artifact }: { artifact: PlaywrightArtifact }) {
  return (
    <div className="truncate border-t px-2 py-1 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }} title={artifact.path}>
      {artifact.name}
    </div>
  )
}

export function EmptyPane({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
      <div>
        <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</div>
        <div className="mt-1 max-w-[360px]">{body}</div>
      </div>
    </div>
  )
}

export function EvidenceSection({
  title,
  summary,
  expanded,
  onToggle,
  onOpenSettings,
  children,
}: {
  title: string
  summary: string
  expanded: boolean
  onToggle: () => void
  onOpenSettings?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mt-3 rounded-md px-2 py-1.5" style={{ background: 'var(--bg-selected)' }}>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left text-[11px] font-medium"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>
          {title}
          <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>{summary}</span>
        </button>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium"
            style={{ border: '1px solid var(--border-default)', color: 'var(--accent)' }}
          >
            Settings
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2">
          {children}
        </div>
      )}
    </div>
  )
}

export function EmptyArtifactMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md px-3 py-4 text-center text-[11px]" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}

export function ArtifactActions({
  artifacts,
  videoMode,
  onOpenSettings,
}: {
  artifacts: PlaywrightArtifact[]
  videoMode: string
  onOpenSettings?: () => void
}) {
  const videos = artifacts.filter((artifact) => artifact.kind === 'video')
  const [openVideoPath, setOpenVideoPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const openVideo = videos.find((artifact) => artifact.path === openVideoPath) ?? null
  const summary = videos.length > 0
    ? `${videos.length} retained`
    : videoMode === 'off'
      ? 'Disabled'
      : 'No video retained'
  return (
    <EvidenceSection
      title="Video"
      summary={summary}
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      onOpenSettings={onOpenSettings}
    >
      <div className="flex flex-wrap gap-2">
        {videos.map((artifact) => (
          <button
            key={artifact.path}
            type="button"
            onClick={() => setOpenVideoPath(openVideoPath === artifact.path ? null : artifact.path)}
            className="rounded px-2.5 py-1 text-[11px] font-medium"
            style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
          >
            {openVideoPath === artifact.path ? 'Hide video' : 'Open video'}
          </button>
        ))}
      </div>
      {videos.length === 0 && (
        <EmptyArtifactMessage>{videoGuidance(videoMode)}</EmptyArtifactMessage>
      )}
      {openVideo && (
        <div className="mt-2 overflow-hidden rounded-md" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
          <video src={openVideo.url} controls className="block max-h-[360px] w-full" />
          <ArtifactCaption artifact={openVideo} />
        </div>
      )}
    </EvidenceSection>
  )
}

export function videoGuidance(mode: string): string {
  if (mode === 'off') return 'Video disabled.'
  return 'No video retained.'
}

export function BrowserActions({ steps }: { steps: PlaybackTest['steps'] }) {
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="mt-3 rounded-md px-2 py-1.5" style={{ background: 'var(--bg-selected)' }}>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="text-[11px] font-medium"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>
        Browser actions ({steps.length})
      </button>
      {expanded && (
        <ol className="mt-2 space-y-1.5">
          {steps.map((step, idx) => (
            <li key={`${step.title}:${idx}`} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <span className="text-right" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{idx + 1}</span>
              <span className="min-w-0 truncate" title={step.title}>
                {step.title}
                {!step.ended && <span style={{ color: 'var(--warning)' }}> (running)</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function StatusPill({ passed, status, current }: { passed?: boolean; status?: string; current?: boolean }) {
  const displayStatus = current ? 'testing' : statusFromPlaybackResult({ status, passed })
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusPillClassForStatus(displayStatus)}`}
      style={{ fontFamily: 'var(--font-mono)', minWidth: '3.75rem' }}
    >
      {statusLabel(displayStatus)}
    </span>
  )
}

export function currentPlaybackIndex(tests: PlaybackTest[], runningName?: string): number {
  if (!runningName) return -1
  for (let i = tests.length - 1; i >= 0; i--) {
    if (tests[i].name === runningName && !tests[i].endedAt) return i
  }
  for (let i = tests.length - 1; i >= 0; i--) {
    if (tests[i].name === runningName) return i
  }
  return -1
}

export function isPlaywrightLifecyclePhase(phase: RunLifecycleEvent['phase']): boolean {
  return phase === 'running-tests' || phase === 'rerunning-tests'
}

export function formatSummaryTestName(name: string): string {
  return name.replace(/^test-case-/, '').replace(/-/g, ' ')
}

export function shortLocation(location: string): string {
  const parts = location.split('/')
  return parts.slice(-2).join('/')
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </h2>
  )
}
