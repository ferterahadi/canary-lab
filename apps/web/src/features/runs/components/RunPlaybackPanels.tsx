import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PlaywrightArtifact } from '@shared/run-detail'
import type { RunLifecycleEvent } from '@shared/run-state'
import { parseAssertionError } from '../utils/assertion-error'
import type { PlaybackTest } from '../utils/run-detail-playback'
import { DownloadIcon, ImageIcon, StepsIcon, VideoIcon } from '@/shared/ui/Icons'

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
