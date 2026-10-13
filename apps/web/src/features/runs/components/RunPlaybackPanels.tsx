import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { PlaywrightArtifact, RunDetail } from '@shared/run-detail'
import { mediaForAttempt, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { RunLifecycleEvent } from '@shared/run-state'
import { EmptyState } from '@/shared/ui/EmptyState'
import { DownloadIcon, GearIcon, ImageIcon, StepsIcon, VideoIcon } from '@/shared/ui/Icons'
import { attemptStatus, mediaGapCopy, missingMediaCopy } from '../utils/results-fixes'
import { parseSourceLocation } from '@shared/lib/source-location'
import { artifactsUnderPolicy, compactPlaybackSteps, type CompactStep } from '../utils/run-detail-playback'

type EvidenceKey = 'steps' | 'screenshot' | 'video'

/**
 * One run's evidence as tabs: Steps, Screenshot, Video, with the trace download
 * at the bar's right end. One panel is always open and it fills the space it is
 * given, so switching tabs never resizes the dialog around it; a long step list
 * or a tall screenshot scrolls inside. An empty tab is the whole view, so it
 * says why in the full empty state rather than a muted line.
 *
 * No Settings link here: the artifact policy is one setting for the whole
 * suite, so its control sits on the pane's rail — not on every test.
 */
export function AttemptEvidence({ attempt, evidence, media, policy, onOpenSettings }: {
  attempt: EvidenceAttempt
  evidence: RunEvidence
  media: Pick<RunDetail, 'attemptArtifacts' | 'playwrightArtifacts'>
  policy?: PlaywrightArtifactPolicy
  /** Opens the suite's artifact settings — the control the empty states'
   *  "turn it on in Artifact settings" points at. */
  onOpenSettings?: () => void
}) {
  const [open, setOpen] = useState<EvidenceKey>('steps')
  const found = mediaForAttempt(attempt, evidence, media)
  const shown = artifactsUnderPolicy(found.kind === 'none' ? [] : found.artifacts, policy)
  const videos = shown.links.filter((a) => a.kind === 'video')
  const traces = shown.links.filter((a) => a.kind === 'trace')
  const steps = compactPlaybackSteps(attempt.steps)
  const numbered = steps.some((step) => step.location && parseSourceLocation(step.location).line)
  const videoMode = policy?.video ?? 'off'
  const passed = attemptStatus(attempt) === 'passed'
  const pending = found.kind === 'none' && found.reason === 'pending'
  const why = (kind: 'screenshot' | 'video', mode: string) => found.kind === 'none' && found.reason !== 'pending' ? mediaGapCopy(found.reason) : missingMediaCopy(kind, mode, passed)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="attempt-evidence">
      <div className="flex flex-none items-center gap-2 px-5 py-2.5">
        <div role="tablist" aria-label="Evidence" className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md border p-0.5" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}>
          <EvidenceTab id="steps" icon={<StepsIcon />} label="Steps" badge={String(steps.length)} has={steps.length > 0} open={open === 'steps'} onClick={() => setOpen('steps')} />
          <EvidenceTab id="screenshot" icon={<ImageIcon />} label="Screenshot" badge={shown.screenshots.length > 0 ? String(shown.screenshots.length) : shown.screenshotMode === 'off' ? 'Off' : 'None'} has={shown.screenshots.length > 0} open={open === 'screenshot'} onClick={() => setOpen('screenshot')} />
          <EvidenceTab id="video" icon={<VideoIcon />} label="Video" badge={videos.length > 0 ? String(videos.length) : videoMode === 'off' ? 'Off' : 'None'} has={videos.length > 0} open={open === 'video'} onClick={() => setOpen('video')} />
        </div>
        <div className="min-w-2 flex-1" />
        <TraceActions artifacts={traces} />
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="Choose which Playwright artifacts this suite keeps — screenshots, video, trace"
            className="cl-button inline-flex shrink-0 items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
          >
            <GearIcon size={11} />
            Artifact settings
          </button>
        )}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t px-5 py-3 scrollbar-thin" style={{ borderColor: 'var(--border-default)' }}>
        {open === 'steps' && (steps.length > 0 ? (
          <ol className="m-0 list-none p-0" data-testid="evidence-steps">
            {steps.map((step, idx) => <StepRow key={`${step.title}:${idx}`} step={step} numbered={numbered} specFile={attempt.location ? parseSourceLocation(attempt.location).file : undefined} />)}
          </ol>
        ) : pending ? (
          <EmptyState reason="not-yet" title="No steps yet" body={PENDING_MEDIA} />
        ) : (
          <EmptyState reason="not-captured" title="No steps recorded" body="Playwright reported no steps for this run, which happens when a test is skipped or stops before its first action. See Screenshot and Video." />
        ))}
        {open === 'screenshot' && (shown.screenshots.length > 0 ? (
          <div className="grid grid-cols-1 gap-2">{shown.screenshots.map((a) => <ScreenshotPreview key={a.path} artifact={a} />)}</div>
        ) : (
          <EmptyState reason={pending ? 'not-yet' : 'not-captured'} title={pending ? 'No screenshot yet' : 'No screenshot for this run'} body={pending ? PENDING_MEDIA : why('screenshot', shown.screenshotMode)} />
        ))}
        {open === 'video' && (videos.length > 0 ? (
          <div className="flex flex-col gap-2">
            {videos.map((a) => (
              <div key={a.path} className="overflow-hidden rounded-md" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
                <video src={a.url} controls preload="metadata" className="block max-h-[440px] w-full" />
                <ArtifactCaption artifact={a} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState reason={pending ? 'not-yet' : 'not-captured'} title={pending ? 'No video yet' : 'No video for this run'} body={pending ? PENDING_MEDIA : why('video', videoMode)} />
        ))}
      </div>
    </div>
  )
}

/** Labels a folded row shows before "Show all". */
const LABELS_SHOWN = 24

/** One row of the Steps tab. The gutter holds the spec line the step ran
 *  from, so a row points back at its code; a step from another file (a
 *  helper) names that file. A loop's passes are one row whose labels open.
 *  A list with no located step drops the gutter rather than indent every
 *  title past an empty column. */
function StepRow({ step, numbered, specFile }: { step: CompactStep; numbered: boolean; specFile?: string }) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const at = step.location ? parseSourceLocation(step.location) : undefined
  const elsewhere = at && specFile && !sameFile(at.file, specFile) ? at.file.split(/[\\/]/).at(-1) : undefined
  const labels = step.labels ?? []
  const shown = all ? labels : labels.slice(0, LABELS_SHOWN)
  return (
    <li data-testid="evidence-step">
      <div className={`grid ${numbered ? 'grid-cols-[48px_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'} items-baseline gap-x-3 py-1 text-[12px]`}>
        {numbered && (
          <span className="text-right text-[10.5px] tabular-nums" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} data-testid="evidence-step-line">
            {at?.line ? `${at.line}${step.toLine ? `–${step.toLine}` : ''}` : ''}
          </span>
        )}
        <span className="min-w-0" style={{ color: 'var(--text-primary)' }}>
          <span className="break-words">{step.title}</span>
          {step.count && <span className="cl-count-chip ml-2 align-middle text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>×{step.count}</span>}
          {!step.ended && <span style={{ color: 'var(--warning)' }}> (running)</span>}
        </span>
        <span className="flex items-baseline gap-3 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {elsewhere && <span title={step.location}>{elsewhere}</span>}
          {labels.length > 0 && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="cursor-pointer hover:text-[var(--text-secondary)]" data-testid="evidence-step-labels-toggle">
              {open ? '⌄' : '›'} each labelled
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className={`pb-2 ${numbered ? 'pl-[60px]' : ''}`} data-testid="evidence-step-labels">
          {/* Ids (a hash, a run id) only need telling apart, so they tile and
              shorten; a sentence is the label's whole point, so it reads in full. */}
          {labels.every((label) => !/\s/.test(label)) ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1">
              {shown.map((label, i) => (
                <span key={`${label}:${i}`} title={label} className="truncate rounded px-1.5 py-0.5 text-center text-[10.5px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {label.length > 16 ? `${label.slice(0, 12)}…` : label}
                </span>
              ))}
            </div>
          ) : (
            <ul className="m-0 list-none space-y-0.5 p-0 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
              {shown.map((label, i) => <li key={`${label}:${i}`}>{label}</li>)}
            </ul>
          )}
          {labels.length > LABELS_SHOWN && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-1.5 cursor-pointer text-[11px] text-accent hover:underline">
              {all ? 'Show fewer' : `Show all ${labels.length}`}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** One file, however each side spelled its path (absolute or project-relative). */
function sameFile(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, '/')
  const [x, y] = [norm(a), norm(b)]
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

const PENDING_MEDIA = "Playwright keeps a run's steps, screenshot and video when its execution ends. This one is still running, so they appear once it finishes."

/** One tab of the evidence switcher: an icon, the label, and a badge with the
 *  count (or why there is none). Kept evidence reads in the secondary tone;
 *  absent evidence stays muted. */
export function EvidenceTab({
  id,
  icon,
  label,
  badge,
  has,
  open,
  onClick,
}: {
  id: string
  icon: ReactNode
  label: string
  badge: string
  has: boolean
  open: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={open}
      data-testid={`evidence-tab-${id}`}
      className="inline-flex shrink-0 items-baseline gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors duration-150 hover:bg-[var(--bg-hover)]"
      style={{
        background: open ? 'var(--bg-selected)' : undefined,
        boxShadow: open ? 'inset 0 0 0 1px var(--border-default)' : undefined,
        color: open ? 'var(--text-primary)' : has ? 'var(--text-secondary)' : 'var(--text-muted)',
      }}
    >
      <span aria-hidden="true" className="inline-flex self-center" style={{ color: open ? 'var(--accent)' : 'currentColor' }}>{icon}</span>
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
