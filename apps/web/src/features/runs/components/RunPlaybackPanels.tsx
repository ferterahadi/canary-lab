import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlaywrightArtifact, PlaywrightArtifactGroup, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent, RunLifecycleEvent, RunSummary } from '@/shared/api/types'
import { formatDuration } from '@/shared/lib/format'
import { artifactsForPlayback, playbackTests, type PlaybackTest } from '../utils/run-detail-playback'
import { statusFromPlaybackResult, statusLabel, statusPillClassForStatus } from '../utils/test-step-status'
import { EmptyState } from '@/shared/ui/EmptyState'
import { DownloadIcon } from '@/shared/ui/Icons'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { buildTestNumbering, parseLocation, stripLeadingTestOrdinal, testNumberKey } from '@/shared/test-numbering'
import { formatLifecycleTime } from './RunDiagnosticsPanels'

export type PlaywrightView = 'terminal' | 'playback'

/** Playwright's Terminal / Playback switch. Same face and geometry as the run's
 *  primary tabs — it is sub-navigation, so it should look like navigation. */
export function SegmentButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`cl-tab shrink-0 whitespace-nowrap ${props.active ? 'cl-tab-active' : ''}`}
    >
      {props.children}
    </button>
  )
}

export function PlaywrightPlayback({
  events,
  artifactGroups,
  artifactPolicy,
  summary,
  totalTests,
  embedded = false,
  focusTest,
}: {
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
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
      <div className="space-y-3">
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
              className={`cl-card px-3.5 py-3${isFocused ? ' border-l-2 border-l-accent' : ''}`}
            >
              {/* Row 1 is identity then verdict — `#4  FAILED` — plus the trace
                  on the right. Row 2 is the title alone. The title used to share
                  a line with all three and lost, truncating to a third of the
                  card; it now gets the full width. */}
              <div className="flex min-w-0 items-center gap-2">
                <TestIdBadge n={(() => { const p = parseLocation(test.location); return p ? testNumbering.get(testNumberKey(p.file, p.line)) : undefined })()} />
                <StatusPill passed={test.passed} status={test.status} current={isCurrent} />
                <div className="min-w-2 flex-1" />
                <TraceActions artifacts={traceArtifacts} />
              </div>
              <PlaybackHeader test={test} current={isCurrent} />
              {test.error?.message ? (
                <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-md p-2.5 scrollbar-thin" style={{ background: 'var(--bg-selected)', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
                  {test.error.message}
                </pre>
              ) : isCurrent ? (
                <div className="mt-1.5 text-[11px]" style={{ color: 'var(--accent)' }}>
                  Currently executing in this Playwright process.
                </div>
              ) : test.passed !== true && test.status ? (
                <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Status: {test.status}</div>
              ) : null}
              <EvidenceRail
                screenshots={playbackArtifacts.screenshots}
                screenshotMode={playbackArtifacts.screenshotMode}
                videos={videoArtifacts}
                videoMode={artifactPolicy?.video ?? 'off'}
                steps={test.steps}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One rail for everything the test left behind.
 *
 * Screenshot and Video each used to be a full-width filled bar, stacked, plus a
 * third for browser actions — three heavy blocks on every card, most of them
 * saying "nothing retained". They collapse to one row of disclosure chips with
 * at most one panel open, so a passing test with no artifacts costs a single
 * quiet line instead of three grey slabs.
 *
 * No Settings link here: the artifact policy is one setting for the whole
 * feature, so one control belongs on the pane's rail (`PlaywrightPanel`) — not
 * a copy of it on every card in the list.
 */
export function EvidenceRail({
  screenshots,
  screenshotMode,
  videos,
  videoMode,
  steps,
}: {
  screenshots: PlaywrightArtifact[]
  screenshotMode: string
  videos: PlaywrightArtifact[]
  videoMode: string
  steps: PlaybackTest['steps']
}) {
  const [open, setOpen] = useState<'screenshot' | 'video' | 'steps' | null>(null)
  const toggle = (key: 'screenshot' | 'video' | 'steps'): void => setOpen((cur) => (cur === key ? null : key))
  const screenshotNote = screenshotMode === 'off' ? 'Disabled' : screenshots.length === 0 ? 'No screenshot retained' : `${screenshots.length} retained`
  const videoNote = videos.length > 0 ? `${videos.length} retained` : videoMode === 'off' ? 'Disabled' : 'No video retained'
  return (
    <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--border-default)' }}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <EvidenceChip label="Screenshot" note={screenshotNote} count={screenshots.length} open={open === 'screenshot'} onClick={() => toggle('screenshot')} />
        <EvidenceChip label="Video" note={videoNote} count={videos.length} open={open === 'video'} onClick={() => toggle('video')} />
        {steps.length > 0 && (
          <EvidenceChip label={`Steps (${steps.length})`} count={steps.length} open={open === 'steps'} onClick={() => toggle('steps')} />
        )}
      </div>
      {open === 'screenshot' && (
        <div className="mt-2">
          {screenshotMode === 'off' ? (
            <EmptyArtifactMessage>Screenshot disabled.</EmptyArtifactMessage>
          ) : screenshots.length === 0 ? (
            <EmptyArtifactMessage>No screenshot retained.</EmptyArtifactMessage>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {screenshots.map((artifact) => (
                <ScreenshotPreview key={artifact.path} artifact={artifact} />
              ))}
            </div>
          )}
        </div>
      )}
      {open === 'video' && <VideoPanel videos={videos} videoMode={videoMode} />}
      {open === 'steps' && (
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

/** A disclosure chip. Present evidence gets the accent + a count; absent
 *  evidence stays muted and states why, so the card never hides a "why is there
 *  no screenshot?" behind a click. */
export function EvidenceChip({
  label,
  note,
  count,
  open,
  onClick,
}: {
  label: string
  note?: string
  count: number
  open: boolean
  onClick: () => void
}) {
  const has = count > 0
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-medium transition-colors duration-150"
      style={{
        background: open ? 'var(--bg-selected)' : 'transparent',
        color: has ? 'var(--text-secondary)' : 'var(--text-muted)',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
      {label}
      {note && <span className="font-normal" style={{ color: 'var(--text-muted)' }}>{note}</span>}
    </button>
  )
}

export function VideoPanel({ videos, videoMode }: { videos: PlaywrightArtifact[]; videoMode: string }) {
  const [openVideoPath, setOpenVideoPath] = useState<string | null>(null)
  const openVideo = videos.find((artifact) => artifact.path === openVideoPath) ?? null
  return (
    <div className="mt-2">
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
      {videos.length === 0 && <EmptyArtifactMessage>{videoGuidance(videoMode)}</EmptyArtifactMessage>}
      {openVideo && (
        <div className="mt-2 overflow-hidden rounded-md" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
          <video src={openVideo.url} controls className="block max-h-[360px] w-full" />
          <ArtifactCaption artifact={openVideo} />
        </div>
      )}
    </div>
  )
}

/** Trace download, icon-only. The words "Download trace" were the widest thing
 *  on the card's top row and repeated on every card; the arrow-into-tray mark
 *  plus its tooltip says the same in a fifth of the width. */
export function TraceActions({ artifacts }: { artifacts: PlaywrightArtifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-1">
      {artifacts.map((artifact) => (
        <a
          key={artifact.path}
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          download={artifact.name}
          aria-label="Download trace"
          title="Download the Playwright trace — open it at trace.playwright.dev to step through this test"
          className="cl-icon-button h-6 w-6 max-w-full truncate"
          style={{ color: 'var(--accent)' }}
        >
          <DownloadIcon size={13} />
        </a>
      ))}
    </div>
  )
}

/** Title + timing, on their own rows under the verdict line. The title wraps to
 *  two lines rather than truncating at a third of the card — a Playwright test
 *  name carries its `@req-…`/`@path-…` tags up front, so the tail is the part
 *  that actually says what the test does. */
export function PlaybackHeader({ test, current }: { test: PlaybackTest; current: boolean }) {
  const location = test.location ? shortLocation(test.location) : null
  return (
    <div className="mt-2.5 min-w-0">
      <div
        className="min-w-0 text-[12.5px] font-medium leading-snug"
        style={{ color: current ? 'var(--accent)' : 'var(--text-primary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        title={test.title}
      >
        {stripLeadingTestOrdinal(test.title)}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        {typeof test.durationMs === 'number' && <span>{formatDuration(test.durationMs)}</span>}
        {test.startedAt && <><Dot />{formatLifecycleTime(test.startedAt)}</>}
        {typeof test.retry === 'number' && test.retry > 0 && <><Dot /><span style={{ color: 'var(--warning)' }}>retry {test.retry}</span></>}
        {location && <><Dot /><span className="min-w-0 truncate" title={test.location}>{location}</span></>}
      </div>
    </div>
  )
}

function Dot() {
  return <span aria-hidden="true" style={{ opacity: 0.5 }}>·</span>
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

/** Run-scoped empty pane — the shared `EmptyState` on the run panes' surface. */
export function EmptyPane({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <EmptyState
      {...(icon ? { icon } : {})}
      title={title}
      body={body}
      {...(action ? { action } : {})}
    />
  )
}

export function EmptyArtifactMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md px-3 py-4 text-center text-[11px]" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}

export function videoGuidance(mode: string): string {
  if (mode === 'off') return 'Video disabled.'
  return 'No video retained.'
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

/** The one section-label voice in the run panes: the system rubric (mono caps,
 *  `styles.css`). Field labels inside the panes use the same class, so a pane
 *  reads as one register instead of a sans caps heading over mono caps rows. */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="cl-rubric mb-2">{children}</h2>
}
