import { useCallback, useEffect, useState } from 'react'
import type {
  PlaywrightArtifact,
  PlaywrightArtifactGroup,
  PlaywrightArtifactPolicy,
  PlaywrightPlaybackEvent,
  RepoBranchSnapshot,
  ServiceManifestEntry,
  ServiceStatus,
  RunLifecycleEvent,
  RunLifecycleSnapshot,
} from '../api/types'
import { formatDuration, durationBetween } from '../lib/format'
import {
  artifactsForPlayback,
  branchForService,
  branchLabel,
  branchTooltip,
  playbackTests,
  type PlaybackTest,
} from '../lib/run-detail-playback'
import { statusFromPlaybackResult, statusLabel, statusPillClassForStatus } from '../lib/test-step-status'
import { useRun } from '../state/RunsContext'
import { deriveRunViewModel } from '../lib/run-view-model'
import { RunStatusIndicator } from './RunStatusIndicator'
import { PaneTerminal } from './PaneTerminal'
import { AgentSessionView } from './AgentSessionView'
import { JournalTab } from './JournalTab'
import { ManualHealBanner } from './ManualHealBanner'
import { RestartHealButton } from './RestartHealButton'

type Tab = 'overview' | 'services' | 'playwright' | 'agent' | 'journal'
type PlaywrightView = 'terminal' | 'playback'

export function RunDetailColumn({
  runId,
  onOpenPlaywrightSettings,
}: {
  runId: string | null
  onOpenPlaywrightSettings?: (feature: string) => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [serviceIdx, setServiceIdx] = useState(0)
  const [playwrightView, setPlaywrightView] = useState<PlaywrightView>('playback')
  const [agentPaneRestartKey, setAgentPaneRestartKey] = useState(0)
  const [agentPaneExited, setAgentPaneExited] = useState(false)

  // Detail comes from the WebSocket-backed RunsContext. No polling here —
  // the same `state.details[runId]` populated for the runs list is reused,
  // so the header badge flips status the instant the server pushes the
  // next `update` frame. The transient action (e.g. user clicked Stop in
  // the runs list) is overlaid into `displayStatus` so this header shows
  // `ABORTING` mid-action instead of stale `RUNNING`.
  const { detail, transient } = useRun(runId)
  const handleAgentPaneExit = useCallback(() => {
    setAgentPaneExited(true)
  }, [])

  useEffect(() => {
    setAgentPaneExited(false)
  }, [runId, agentPaneRestartKey])

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Select a run
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  const m = detail.manifest
  const view = deriveRunViewModel(detail, transient)
  const services = m.services
  const repoBranches = m.repoBranches ?? []
  const activeService = services[serviceIdx]
  const showAgentSession = isTerminalRunStatus(m.status) || agentPaneExited

  return (
    <div className="cl-panel relative flex h-full flex-col">
      <header className="cl-panel-header px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">
            <RunStatusIndicator status={view.displayStatus} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} title={m.runId}>{m.runId}</span>
          <span className="shrink-0 truncate text-xs" style={{ color: 'var(--text-muted)' }} title={m.feature}>{m.feature}</span>
        </div>
        <nav className="mt-2 -mx-1 flex gap-1 overflow-x-auto px-1 text-xs scrollbar-thin">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          <TabButton active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0}>Services</TabButton>
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>Heal agent</TabButton>
          <TabButton active={tab === 'journal'} onClick={() => setTab('journal')}>Journal</TabButton>
        </nav>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden mt-2">
        {tab === 'overview' && (
          <div className="h-full overflow-y-auto scrollbar-thin p-4 text-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                Run
              </h2>
              {isAssertionExportable(m.status) && (
                <a
                  href={assertionHref(m.runId)}
                  download={assertionFilename(m.feature, m.runId)}
                  className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium"
                  style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
                >
                  Export Assertion
                </a>
              )}
            </div>
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-xs">
                <dt style={{ color: 'var(--text-muted)' }}>Feature</dt>
                <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={m.feature}>{m.feature}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Duration</dt>
                <dd style={{ color: 'var(--text-primary)' }}>{(() => {
                  const d = durationBetween(m.startedAt, m.endedAt)
                  return d == null ? 'in progress' : formatDuration(d)
                })()}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Started</dt>
                <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={m.startedAt}>{m.startedAt}</dd>
                {m.endedAt && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>Ended</dt>
                    <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={m.endedAt}>{m.endedAt}</dd>
                  </>
                )}
                {m.healCycles > 0 && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>Heal cycles</dt>
                    <dd style={{ color: 'var(--text-secondary)' }}>{m.healCycles}</dd>
                  </>
                )}
                {m.lifecycle && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>State</dt>
                    <dd style={{ color: 'var(--text-secondary)' }}>{view.headline}</dd>
                  </>
                )}
            </dl>
            {view.recoveryTimeline.length > 0 && (
              <RecoverySection
                events={view.recoveryTimeline}
                alert={view.primaryAlert}
              />
            )}
            {repoBranches.length > 0 && (
              <div className="mt-4">
                <SectionHeader>Branches</SectionHeader>
                <ul className="space-y-2">
                  {repoBranches.map((repo) => (
                    <BranchCard key={`${repo.name}:${repo.path}`} repo={repo} />
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4">
              <SectionHeader>Services</SectionHeader>
              {services.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
              ) : (
                <ul className="space-y-2">
                  {services.map((s) => (
                    <ServiceCard key={s.safeName} service={s} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {tab === 'services' && services.length > 0 && (
          <div className="flex h-full flex-col">
            <div className="cl-panel-header flex gap-1 overflow-x-auto px-3 py-1.5 text-xs scrollbar-thin">
              {services.map((s, i) => (
                <ServiceTabButton
                  key={s.safeName}
                  service={s}
                  branch={branchForService(s, repoBranches)}
                  active={i === serviceIdx}
                  onClick={() => setServiceIdx(i)}
                />
              ))}
            </div>
            <div className="flex-1 min-h-0">
              {activeService && (
                <PaneTerminal runId={m.runId} paneId={`service:${activeService.safeName}`} />
              )}
            </div>
          </div>
        )}
        {tab === 'playwright' && (
          <PlaywrightPanel
            runId={m.runId}
            view={playwrightView}
            onViewChange={setPlaywrightView}
            events={detail.playbackEvents}
            artifactGroups={detail.playwrightArtifacts}
            artifactPolicy={m.playwrightArtifacts}
            onOpenArtifactSettings={() => onOpenPlaywrightSettings?.(m.feature)}
            lifecycle={m.lifecycle}
          />
        )}
        {tab === 'agent' && (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {m.healMode === 'manual' && m.status === 'healing' && m.signalPaths && (
              <ManualHealBanner runId={m.runId} signalPaths={m.signalPaths} />
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {showAgentSession ? (
                <AgentSessionView runId={m.runId} pollUntilFound={!isTerminalRunStatus(m.status)} />
              ) : (
                <PaneTerminal
                  key={`${m.runId}:agent:${agentPaneRestartKey}`}
                  runId={m.runId}
                  paneId="agent"
                  onExit={handleAgentPaneExit}
                />
              )}
            </div>
            {view.actions.restartHeal.enabled && (
              <RestartHealButton
                runId={m.runId}
                onRestarted={() => setAgentPaneRestartKey((key) => key + 1)}
              />
            )}
          </div>
        )}
        {tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} />
        )}
      </div>
    </div>
  )
}

export function canRestartHeal(status: string): boolean {
  return status === 'failed' || status === 'aborted'
}

// Run has reached a terminal state — the agent pty is gone, so the live
// xterm pane has nothing to subscribe to. Switch to the structured-view
// historical replay (which reads the agent CLI's own JSONL session log).
export function isTerminalRunStatus(status: string): boolean {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

export function isAssertionExportable(status: string): boolean {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

export function assertionFilename(feature: string, runId: string): string {
  return `canary-lab-assertion-${safeFilename(feature)}-${safeFilename(runId)}.zip`
}

export function assertionHref(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/assertion.html`
}

export function hasAssertionVideos(groups: PlaywrightArtifactGroup[] | undefined): boolean {
  return groups?.some((group) => group.artifacts.some((artifact) => artifact.kind === 'video')) ?? false
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

function PlaywrightPanel({
  runId,
  view,
  onViewChange,
  events,
  artifactGroups,
  artifactPolicy,
  onOpenArtifactSettings,
  lifecycle,
}: {
  runId: string
  view: PlaywrightView
  onViewChange: (view: PlaywrightView) => void
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
  lifecycle?: RunLifecycleSnapshot
}) {
  return (
    <div className="flex h-full flex-col">
      {lifecycle?.targetedRerun && (
        <div className="mx-3 mt-3 rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Targeted rerun:</span>{' '}
          {lifecycle.targetedRerun.reason}
        </div>
      )}
      <div className="cl-panel-header flex gap-1 px-3 py-1.5 text-xs">
        <SegmentButton active={view === 'terminal'} onClick={() => onViewChange('terminal')}>Terminal</SegmentButton>
        <SegmentButton active={view === 'playback'} onClick={() => onViewChange('playback')}>Playback</SegmentButton>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'terminal' && <PaneTerminal runId={runId} paneId="playwright" />}
        {view === 'playback' && <PlaywrightPlayback events={events} artifactGroups={artifactGroups} artifactPolicy={artifactPolicy} onOpenArtifactSettings={onOpenArtifactSettings} />}
      </div>
    </div>
  )
}

function RecoverySection({
  events,
  alert,
}: {
  events: RunLifecycleEvent[]
  alert?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }
}) {
  return (
    <div className="mt-4">
      <SectionHeader>Recovery</SectionHeader>
      {alert && (
        <div className={`mb-2 rounded-md border px-2.5 py-2 text-xs ${alertClass(alert.tone)}`}>
          {alert.message}
        </div>
      )}
      <ol className="space-y-2">
        {events.map((event, idx) => (
          <li key={event.id ?? `${event.updatedAt}:${idx}`} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2 text-xs">
            <span className={`mt-1.5 h-2 w-2 rounded-full ${dotClass(event.severity)}`} />
            <span className="min-w-0">
              <span className="block truncate" style={{ color: 'var(--text-primary)' }}>{event.headline}</span>
              {event.detail && <span className="block" style={{ color: 'var(--text-muted)' }}>{event.detail}</span>}
              {event.restartPlan && (
                <span className="block" style={{ color: 'var(--text-muted)' }}>{formatRestartPlan(event.restartPlan)}</span>
              )}
              {event.targetedRerun && (
                <span className="block" style={{ color: 'var(--text-muted)' }}>
                  {event.targetedRerun.selected}/{event.targetedRerun.total} selected
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function alertClass(tone: 'info' | 'success' | 'warning' | 'error'): string {
  if (tone === 'success') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (tone === 'warning') return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (tone === 'error') return 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
}

function dotClass(severity: RunLifecycleEvent['severity']): string {
  if (severity === 'success') return 'bg-emerald-500'
  if (severity === 'warning') return 'bg-amber-500'
  if (severity === 'error') return 'bg-rose-500'
  return 'bg-sky-500'
}

function formatRestartPlan(plan: NonNullable<RunLifecycleEvent['restartPlan']>): string {
  const parts: string[] = []
  if (plan.restarted.length > 0) parts.push(`restarted ${plan.restarted.join(', ')}`)
  if (plan.kept.length > 0) parts.push(`kept ${plan.kept.join(', ')}`)
  if ((plan.startedBecauseMissing ?? []).length > 0) parts.push(`started missing ${(plan.startedBecauseMissing ?? []).join(', ')}`)
  return parts.join('; ')
}

function SegmentButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
}: {
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
}) {
  const tests = playbackTests(events)
  if (tests.length === 0) {
    return <EmptyPane title="No playback events captured yet." body="Use Terminal for older runs or runs that ended before structured Playwright events were written." />
  }
  return (
    <div className="h-full overflow-y-auto p-3 text-xs scrollbar-thin" style={{ background: 'var(--bg-base)' }}>
      <div className="space-y-2">
        {tests.map((test) => {
          const playbackArtifacts = artifactsForPlayback(test.name, artifactGroups, artifactPolicy)
          const traceArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'trace')
          const videoArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'video')
          return (
            <div key={`${test.name}:${test.retry ?? 0}:${test.startedAt ?? ''}`} className="cl-card p-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <PlaybackHeader test={test} />
                </div>
                <TraceActions artifacts={traceArtifacts} />
              </div>
              {test.error?.message ? (
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md p-2 scrollbar-thin" style={{ background: 'var(--bg-selected)', color: '#ef4444', fontFamily: 'var(--font-mono)' }}>
                  {test.error.message}
                </pre>
              ) : (
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {test.passed === true ? 'Completed without a Playwright error.' : test.status ? `Status: ${test.status}` : 'Still running.'}
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

function TraceActions({ artifacts }: { artifacts: PlaywrightArtifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-2">
      {artifacts.map((artifact) => (
        <a
          key={artifact.path}
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          download={artifact.name}
          className="rounded px-2.5 py-1 text-[11px] font-medium"
          style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
        >
          Download trace
        </a>
      ))}
    </div>
  )
}

function PlaybackHeader({ test }: { test: PlaybackTest }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <StatusPill passed={test.passed} status={test.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" style={{ color: 'var(--text-primary)' }} title={test.title}>
          {test.title}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {typeof test.durationMs === 'number' && <span>{formatDuration(test.durationMs)}</span>}
          {typeof test.retry === 'number' && test.retry > 0 && <span>retry {test.retry}</span>}
        </div>
      </div>
    </div>
  )
}

function ScreenshotPanel({
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

function ScreenshotPreview({ artifact }: { artifact: PlaywrightArtifact }) {
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

function ArtifactCaption({ artifact }: { artifact: PlaywrightArtifact }) {
  return (
    <div className="truncate border-t px-2 py-1 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }} title={artifact.path}>
      {artifact.name}
    </div>
  )
}

function EmptyPane({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
      <div>
        <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</div>
        <div className="mt-1 max-w-[360px]">{body}</div>
      </div>
    </div>
  )
}

function EvidenceSection({
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

function EmptyArtifactMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md px-3 py-4 text-center text-[11px]" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}

function ArtifactActions({
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

function videoGuidance(mode: string): string {
  if (mode === 'off') return 'Video disabled.'
  return 'No video retained.'
}

function BrowserActions({ steps }: { steps: PlaybackTest['steps'] }) {
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
                {!step.ended && <span style={{ color: '#eab308' }}> (running)</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function StatusPill({ passed, status }: { passed?: boolean; status?: string }) {
  const displayStatus = statusFromPlaybackResult({ status, passed })
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusPillClassForStatus(displayStatus)}`}
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {statusLabel(displayStatus)}
    </span>
  )
}

function BranchCard({ repo }: { repo: RepoBranchSnapshot }) {
  const branch = repo.detached ? 'detached HEAD' : repo.branch ?? 'unknown'
  const mismatch = repo.expectedBranch && repo.branch !== repo.expectedBranch
  return (
    <li className="cl-card p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
          {repo.name}
        </div>
        {repo.dirty && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider" style={{ background: 'var(--bg-selected)', color: '#f59e0b' }}>
            dirty
          </span>
        )}
        {mismatch && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider" style={{ background: 'var(--bg-selected)', color: '#f59e0b' }}>
            mismatch
          </span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[58px_minmax(0,1fr)] gap-x-2 gap-y-1">
        <BranchField label="branch" value={branch} />
        {repo.expectedBranch && <BranchField label="expected" value={repo.expectedBranch} />}
        <BranchField label="path" value={repo.path} />
      </div>
    </li>
  )
}

function BranchField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        className="min-w-0 truncate text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
        title={value}
      >
        {value}
      </span>
    </>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </h2>
  )
}

const STATUS_COLOR: Record<ServiceStatus, string> = {
  ready: '#22c55e',
  starting: '#eab308',
  timeout: '#ef4444',
  stopped: 'var(--text-muted)',
}

function ServiceTabButton({
  service,
  branch,
  active,
  onClick,
}: {
  service: ServiceManifestEntry
  branch: RepoBranchSnapshot | null
  active: boolean
  onClick: () => void
}) {
  const label = branch ? branchLabel(branch) : null
  return (
    <button
      type="button"
      onClick={onClick}
      title={branch ? branchTooltip(service, branch) : service.name}
      className={`cl-tab flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      <ServiceStatusDot status={service.status} />
      <span className="max-w-[150px] truncate">{service.name}</span>
      {label && (
        <span className="max-w-[120px] truncate rounded px-1 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: branch?.dirty ? '#f59e0b' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          @ {label}
        </span>
      )}
    </button>
  )
}

function ServiceCard({ service }: { service: { name: string; command: string; cwd: string; logPath: string; healthUrl?: string; status?: ServiceStatus } }) {
  return (
    <li className="cl-card p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{service.name}</div>
        {service.status && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: 'var(--bg-selected)', color: STATUS_COLOR[service.status] }}
          >
            {service.status}
          </span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        <ServiceField label="cmd" value={service.command} />
        <ServiceField label="cwd" value={service.cwd} />
        <ServiceField label="log" value={service.logPath} />
        {service.healthUrl && <ServiceField label="url" value={service.healthUrl} href={service.healthUrl} />}
      </div>
    </li>
  )
}

function ServiceField({ label, value, href }: { label: string; value: string; href?: string }) {
  const onCopy = () => {
    void navigator.clipboard?.writeText(value)
  }
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        className="min-w-0 truncate text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
        title={value}
      >
        {value}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${label}`}
            className="cl-icon-button h-5 w-5"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v7H3V3h7" />
            </svg>
          </a>
        )}
        {!href && (
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
            className="cl-icon-button h-5 w-5"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
      </span>
    </>
  )
}

function ServiceStatusDot({ status }: { status?: ServiceStatus }) {
  // Fixed 6×6 slot reserved regardless of status, so the chip text never
  // shifts when the dot appears/disappears (e.g. on `stopped`).
  const color =
    status === 'ready' ? '#22c55e'      // green
    : status === 'starting' ? '#eab308' // yellow (pulses)
    : status === 'timeout' ? '#ef4444'  // red
    : 'transparent'                     // stopped or undefined
  return (
    <span
      aria-label={status ? `service ${status}` : undefined}
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0${status === 'starting' ? ' canary-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

function TabButton(props: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, disabled, onClick, children } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`cl-tab shrink-0 whitespace-nowrap px-2.5 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        color: active ? 'var(--text-primary)' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}
