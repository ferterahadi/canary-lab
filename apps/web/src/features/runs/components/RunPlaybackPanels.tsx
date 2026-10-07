import { shortSourceLocation } from '@shared/lib/source-location'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PlaywrightArtifact,
  PlaywrightArtifactGroup,
  PlaywrightPlaybackEvent,
  RunSummary,
} from '@shared/run-detail'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { RunLifecycleEvent } from '@shared/run-state'
import { formatDuration } from '@/shared/lib/format'
import { parseAssertionError } from '../utils/assertion-error'
import { artifactsForPlayback, playbackTests, type PlaybackTest } from '../utils/run-detail-playback'
import { statusFromPlaybackResult, statusLabel, statusPillClassForStatus } from '../utils/test-step-status'
import { EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { DownloadIcon, ImageIcon, StepsIcon, VideoIcon } from '@/shared/ui/Icons'
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
    return <EmptyState {...EMPTY_COPY.playback} />
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
    // `p-4`: the run panes' one content inset (`RunPane padded`), so a test card
    // starts on the same edge and at the same height as the Overview's cards.
    <div className={`${embedded ? '' : 'h-full overflow-y-auto scrollbar-thin'} p-4 text-xs`} style={{ background: 'var(--bg-base)' }}>
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
              className="cl-card overflow-hidden"
              // Inline, not a `border-*` utility: `.cl-card` is unlayered, so its
              // border colour beats any utility beside it. The landing marker
              // (accent) outranks the verdict tone — it is the one card you came
              // to read.
              style={cardBorder(isFocused, test, isCurrent)}
            >
              {/* The title strip: identity, title, duration, verdict — the same
                  anatomy as the Overview's service cards, state on the right. */}
              <div className="cl-card-head">
                <TestIdBadge n={(() => { const p = parseLocation(test.location); return p ? testNumbering.get(testNumberKey(p.file, p.line)) : undefined })()} />
                <PlaybackTitle test={test} current={isCurrent} />
                {typeof test.durationMs === 'number' && (
                  <span className="shrink-0 tabular-nums text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {formatDuration(test.durationMs)}
                  </span>
                )}
                <StatusPill passed={test.passed} status={test.status} current={isCurrent} />
              </div>
              <div className="cl-card-body">
                <PlaybackMeta test={test} />
                {test.error?.message ? (
                  <AssertionMessage message={test.error.message} />
                ) : isCurrent ? (
                  <div className="mt-1.5 text-[11px]" style={{ color: 'var(--running)' }}>
                    Currently executing in this Playwright process.
                  </div>
                ) : test.passed !== true && test.status ? (
                  <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Status: {test.status}</div>
                ) : null}
              </div>
              <EvidenceRail
                screenshots={playbackArtifacts.screenshots}
                screenshotMode={playbackArtifacts.screenshotMode}
                videos={videoArtifacts}
                videoMode={artifactPolicy?.video ?? 'off'}
                steps={test.steps}
                traces={traceArtifacts}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The card's foot: one bar for everything the test left behind.
 *
 * Screenshot and Video each used to be a full-width filled bar, stacked, plus a
 * third for browser actions — three heavy blocks on every card, most of them
 * saying "nothing retained". They are segments of one bar now, with at most one
 * panel open under it, so a passing test with no artifacts costs one quiet line.
 * The trace download sits at the bar's right end: it is evidence too, and the
 * title strip stays identity and verdict only.
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
  traces = [],
}: {
  screenshots: PlaywrightArtifact[]
  screenshotMode: string
  videos: PlaywrightArtifact[]
  videoMode: string
  steps: PlaybackTest['steps']
  traces?: PlaywrightArtifact[]
}) {
  const [open, setOpen] = useState<'screenshot' | 'video' | 'steps' | null>(null)
  const toggle = (key: 'screenshot' | 'video' | 'steps'): void => setOpen((cur) => (cur === key ? null : key))
  // A tab's badge is its count when evidence was kept, else the reason there
  // is none — so "why is there no screenshot?" never hides behind a click.
  const screenshotBadge = screenshots.length > 0 ? String(screenshots.length) : screenshotMode === 'off' ? 'Disabled' : 'None'
  const videoBadge = videos.length > 0 ? String(videos.length) : videoMode === 'off' ? 'Disabled' : 'None'
  return (
    <div>
      <div className="cl-card-foot">
        <div
          role="group"
          aria-label="Evidence"
          className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md border p-0.5"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}
        >
          <EvidenceTab
            id="screenshot"
            icon={<ImageIcon />}
            label="Screenshot"
            badge={screenshotBadge}
            hint={screenshotMode === 'off' ? 'Screenshots are disabled for this suite' : screenshots.length === 0 ? 'No screenshot retained' : undefined}
            has={screenshots.length > 0}
            open={open === 'screenshot'}
            onClick={() => toggle('screenshot')}
          />
          <EvidenceTab
            id="video"
            icon={<VideoIcon />}
            label="Video"
            badge={videoBadge}
            hint={videos.length > 0 ? undefined : videoMode === 'off' ? 'Video is disabled for this suite' : 'No video retained'}
            has={videos.length > 0}
            open={open === 'video'}
            onClick={() => toggle('video')}
          />
          {steps.length > 0 && (
            <EvidenceTab
              id="steps"
              icon={<StepsIcon />}
              label="Steps"
              badge={String(steps.length)}
              has
              open={open === 'steps'}
              onClick={() => toggle('steps')}
            />
          )}
        </div>
        <div className="min-w-2 flex-1" />
        <TraceActions artifacts={traces} />
      </div>
      {open !== null && (
        <div className="border-t px-3 pb-3 pt-1" style={{ borderColor: 'var(--border-default)' }}>
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
      )}
    </div>
  )
}

/** One tab of the evidence switcher: an icon, the label, and a badge with the
 *  count (or why there is none). Kept evidence reads in the secondary tone;
 *  absent evidence stays muted. A tab toggles its panel, so at most one panel
 *  is open and a second click closes it. */
export function EvidenceTab({
  id,
  icon,
  label,
  badge,
  hint,
  has,
  open,
  onClick,
}: {
  id: string
  icon: ReactNode
  label: string
  badge: string
  hint?: string
  has: boolean
  open: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      title={hint}
      data-testid={`evidence-tab-${id}`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors duration-150 hover:bg-[var(--bg-hover)]"
      style={{
        background: open ? 'var(--bg-selected)' : undefined,
        boxShadow: open ? 'inset 0 0 0 1px var(--border-default)' : undefined,
        color: open ? 'var(--text-primary)' : has ? 'var(--text-secondary)' : 'var(--text-muted)',
      }}
    >
      <span aria-hidden="true" className="inline-flex" style={{ color: open ? 'var(--accent)' : 'currentColor' }}>{icon}</span>
      {label}
      <span
        data-testid={`evidence-badge-${id}`}
        className="rounded px-1 text-[10px] font-normal tabular-nums"
        style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          background: has ? 'color-mix(in srgb, var(--text-muted) 14%, transparent)' : 'transparent',
        }}
      >
        {badge}
      </span>
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

/** Trace download, the evidence bar's right end. One link per retained trace
 *  (a retried test can leave one per attempt). */
export function TraceActions({ artifacts }: { artifacts: PlaywrightArtifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {artifacts.map((artifact) => (
        <a
          key={artifact.path}
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          download={artifact.name}
          aria-label="Download trace"
          title="Download the Playwright trace — open it at trace.playwright.dev to step through this test"
          className="cl-button inline-flex max-w-full items-center gap-1.5 truncate px-2 py-1 text-[11px] font-medium"
        >
          <DownloadIcon size={12} />
          <span aria-hidden="true">Trace</span>
        </a>
      ))}
    </div>
  )
}

/** The title on the card's strip. It wraps to two lines rather than
 *  truncating — a Playwright test name carries its `@req-…`/`@path-…` tags up
 *  front, so the tail is the part that actually says what the test does. */
export function PlaybackTitle({ test, current }: { test: PlaybackTest; current: boolean }) {
  return (
    <div
      className="min-w-0 flex-1 text-xs font-medium leading-snug"
      style={{ color: current ? 'var(--running)' : 'var(--text-primary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      title={test.title}
    >
      {stripLeadingTestOrdinal(test.title)}
    </div>
  )
}

/** Where and when, the body's first line: the spec location, the start time,
 *  and a retry when there was one. The duration sits on the title strip. */
export function PlaybackMeta({ test }: { test: PlaybackTest }) {
  const location = test.location ? shortSourceLocation(test.location) : null
  const parts: ReactNode[] = []
  if (location) parts.push(<span key="loc" className="min-w-0 truncate" title={test.location}>{location}</span>)
  if (test.startedAt) parts.push(<span key="at">{formatLifecycleTime(test.startedAt)}</span>)
  if (typeof test.retry === 'number' && test.retry > 0) parts.push(<span key="retry" style={{ color: 'var(--warning)' }}>retry {test.retry}</span>)
  if (parts.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<Dot key={`dot-${i}`} />, part]))}
    </div>
  )
}

/** The failure message. A matcher failure lays out as its headline over an
 *  Expected / Received table — the mismatch is the thing to read, so it gets
 *  rows of its own, in Playwright's own green/red. Anything the split cannot
 *  place (a call log, a thrown error, a `toEqual` diff) stays verbatim. */
export function AssertionMessage({ message }: { message: string }) {
  const parts = parseAssertionError(message)
  if (!parts) {
    return <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border p-2.5 scrollbar-thin" style={ERROR_BLOCK_STYLE}>{message}</pre>
  }
  return (
    <div className="mt-2" data-testid="assertion-message">
      <div className="whitespace-pre-wrap break-words text-[11px]" style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>{parts.headline}</div>
      <dl className="mt-2 overflow-hidden rounded-md border text-[11px]" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}>
        <AssertionSide label={parts.expected.label} value={parts.expected.value} color="var(--success)" />
        <AssertionSide label={parts.received.label} value={parts.received.value} color="var(--danger)" divided />
      </dl>
      {parts.rest && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border p-2.5 scrollbar-thin" style={{ ...ERROR_BLOCK_STYLE, color: 'var(--text-secondary)' }}>{parts.rest}</pre>
      )}
    </div>
  )
}

const ERROR_BLOCK_STYLE: React.CSSProperties = {
  borderColor: 'var(--border-default)',
  background: 'var(--bg-base)',
  color: 'var(--danger)',
  fontFamily: 'var(--font-mono)',
}

function AssertionSide({ label, value, color, divided = false }: { label: string; value: string; color: string; divided?: boolean }) {
  return (
    <div className={`grid grid-cols-[112px_minmax(0,1fr)]${divided ? ' border-t' : ''}`} style={divided ? { borderColor: 'var(--border-default)' } : undefined}>
      <dt className="cl-rubric px-2.5 py-1.5">{label}</dt>
      <dd className="whitespace-pre-wrap break-all px-2.5 py-1.5" style={{ color, fontFamily: 'var(--font-mono)' }}>{value}</dd>
    </div>
  )
}

/** The card's border tone. Inline because `.cl-card` is unlayered and its
 *  border colour would beat a utility. */
function cardBorder(focused: boolean, test: PlaybackTest, current: boolean): React.CSSProperties | undefined {
  if (focused) return { borderColor: 'var(--accent)' }
  if (current) return undefined
  const status = statusFromPlaybackResult({ status: test.status, passed: test.passed })
  if (status === 'failed') return { borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }
  if (status === 'timedout') return { borderColor: 'color-mix(in srgb, var(--warning) 45%, var(--border-default))' }
  return undefined
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
      // The tinted fill without its outline: the same chip face as a service's
      // READY on the Overview, so one run speaks one state vocabulary.
      className={`cl-status-chip ${statusPillClassForStatus(displayStatus)}`}
      style={{ minWidth: '3.75rem' }}
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


/** The one section-label voice in the run panes: the system rubric (mono caps,
 *  `styles.css`). Field labels inside the panes use the same class, so a pane
 *  reads as one register instead of a sans caps heading over mono caps rows. */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="cl-rubric mb-2">{children}</h2>
}
