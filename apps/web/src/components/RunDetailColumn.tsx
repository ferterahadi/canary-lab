import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EvaluationExportMode,
  PlaywrightArtifact,
  PlaywrightArtifactGroup,
  PlaywrightArtifactPolicy,
  PlaywrightPlaybackEvent,
  RepoBranchSnapshot,
  ServiceManifestEntry,
  ServiceStatus,
  RunLifecycleEvent,
  RunManifest,
  RunSummary,
  VerificationDiagnostics,
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
import { useEvaluationExports } from '../state/EvaluationExportContext'
import { deriveRunViewModel, type RunViewModel } from '../lib/run-view-model'
import { RunStatusIndicator } from './RunStatusIndicator'
import { PaneTerminal } from './PaneTerminal'
import { AgentSessionView } from './AgentSessionView'
import { ExternalHealPanel } from './ExternalHealPanel'
import { ActivityTab } from './ActivityTab'
import { JournalTab } from './JournalTab'
import { ManualHealBanner } from './ManualHealBanner'
import {
  isRestartableRunStatus,
  isTerminalRunStatus as isSharedTerminalRunStatus,
} from '../../../../shared/run-state'

type Tab = 'overview' | 'run-logs' | 'services' | 'playwright' | 'agent' | 'journal' | 'activity'
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

  // Each new heal cycle spawns a fresh Claude/Codex PTY. Without this, after
  // the previous cycle's PTY exited (and we flipped to the transcript view),
  // the transcript would keep showing for cycle 2+ even though a live PTY is
  // running — because `agentPaneExited` is sticky and `agentPaneRestartKey`
  // never changed. Bumping the restart key remounts PaneTerminal with a
  // fresh connection and (via the effect above) clears the exited flag.
  const lastHealCyclesRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const cycles = detail?.manifest.healCycles
    if (cycles == null) return
    if (lastHealCyclesRef.current !== undefined && cycles > lastHealCyclesRef.current) {
      setAgentPaneRestartKey((k) => k + 1)
    }
    lastHealCyclesRef.current = cycles
  }, [detail?.manifest.healCycles])

  const isVerifyRun = (detail?.manifest.executionType ?? 'run') === 'verify'
  useEffect(() => {
    if (isVerifyRun && tab !== 'overview' && tab !== 'playwright') setTab('overview')
  }, [isVerifyRun, tab])

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
  const isVerify = isVerifyRun
  const view = deriveRunViewModel(detail, transient)
  const services = m.services
  const repoBranches = m.repoBranches ?? []
  const activeService = services[serviceIdx]
  const showAgentSession = isTerminalRunStatus(m.status) || agentPaneExited

  return (
    <div className="cl-panel relative flex h-full flex-col">
      <header className="cl-panel-header px-4 pt-3 pb-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">
            <RunStatusIndicator status={view.displayStatus} />
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={m.runId}
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          >
            {m.runId}
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
            style={{
              background: isVerify ? 'rgba(14, 165, 233, 0.12)' : 'var(--bg-selected)',
              color: isVerify ? 'var(--accent)' : 'var(--text-muted)',
              letterSpacing: '0.04em',
            }}
          >
            {isVerify ? 'Verify' : 'Run'}
          </span>
          <span
            className="shrink-0 truncate text-xs"
            title={m.feature}
            style={{ color: 'var(--text-muted)' }}
          >
            {m.feature}
          </span>
        </div>
        <nav className="mt-3 flex gap-5 overflow-x-auto scrollbar-thin">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          {!isVerify && <TabButton active={tab === 'run-logs'} onClick={() => setTab('run-logs')}>Run Logs</TabButton>}
          {!isVerify && <TabButton active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0}>Services</TabButton>}
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
          {!isVerify && <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>Heal agent</TabButton>}
          {!isVerify && <TabButton active={tab === 'journal'} onClick={() => setTab('journal')}>Journal</TabButton>}
          {!isVerify && <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>Activity</TabButton>}
        </nav>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden mt-2">
        {tab === 'overview' && (
          isVerify ? (
            <VerifyOverviewTab manifest={m} view={view} />
          ) : (
            <RunOverviewTab
              manifest={m}
              view={view}
              services={services}
              repoBranches={repoBranches}
            />
          )
        )}
        {!isVerify && tab === 'run-logs' && (
          <RunLogsTab view={view} summary={detail.summary} />
        )}
        {!isVerify && tab === 'services' && services.length > 0 && (
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
            summary={detail.summary}
            diagnostics={m.verification?.diagnostics}
          />
        )}
        {/* Always rendered, hidden via display:none when another tab is active.
            Keeps the live xterm + WebSocket alive so the Ink-based heal agent
            TUI isn't replayed from scratch on tab return — replaying the raw
            stream re-executes every clear-screen redraw and collapses scrollback
            to the last frame. */}
        {!isVerify && <div hidden={tab !== 'agent'} className="flex h-full min-h-0 flex-col overflow-hidden">
          {m.healMode === 'manual' && view.actions.cancelHeal.enabled && m.signalPaths && (
            <ManualHealBanner runId={m.runId} signalPaths={m.signalPaths} />
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            {m.healMode === 'external' ? (
              // External heal: there is no local PTY to attach. The agent
              // transcript lives in the user's Claude / Codex window once a
              // client claims the run; before that, show the parked state.
              <ExternalHealPanel
                runId={m.runId}
                runStatus={m.status}
                session={m.externalHealSession}
              />
            ) : showAgentSession ? (
              <AgentSessionView source={{ kind: 'run', runId: m.runId, live: !isTerminalRunStatus(m.status) }} />
            ) : (
              <PaneTerminal
                key={`${m.runId}:agent:${agentPaneRestartKey}`}
                runId={m.runId}
                paneId="agent"
                onExit={handleAgentPaneExit}
              />
            )}
          </div>
          {/* Retest lives as a per-row icon in RunsColumn now (see
              RetestIconButton). The footer-bar variant that used to sit here
              duplicated that affordance. */}
        </div>}
        {!isVerify && tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} />
        )}
        {!isVerify && tab === 'activity' && (
          <ActivityTab runId={m.runId} runStatus={m.status} />
        )}
      </div>
    </div>
  )
}

export function canRestartHeal(status: string): boolean {
  return isRestartableRunStatus(status)
}

export function servicePrimaryLabel(
  service: Pick<ServiceManifestEntry, 'name' | 'repoName'>,
  repoNameFallback?: string | null,
): string {
  return service.repoName?.trim() || repoNameFallback?.trim() || service.name
}

export function serviceTabLabelParts(
  service: Pick<ServiceManifestEntry, 'name' | 'repoName'>,
  branch: RepoBranchSnapshot | null,
): { primary: string; branch: string | null } {
  return {
    primary: servicePrimaryLabel(service, branch?.name),
    branch: branch ? branchLabel(branch) : null,
  }
}

interface RunOverviewTabProps {
  manifest: RunManifest
  view: RunViewModel
  services: ServiceManifestEntry[]
  repoBranches: RepoBranchSnapshot[]
}

function RunOverviewTab({
  manifest,
  view,
  services,
  repoBranches,
}: RunOverviewTabProps) {
  const duration = durationBetween(manifest.startedAt, manifest.endedAt)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportError, setExportError] = useState(false)
  const { startExport } = useEvaluationExports()
  const handleExportEvaluation = useCallback(async (mode: EvaluationExportMode) => {
    setExportMenuOpen(false)
    setExportError(false)
    try {
      await startExport(manifest.runId, mode)
    } catch {
      setExportError(true)
    }
  }, [manifest.runId, startExport])

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4 text-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          Run
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {/* Retest is surfaced as an icon-only button on each run row in
              RunsColumn — see RetestIconButton. The inline button used to
              live here, but it duplicated that affordance and felt heavy
              on the overview header. */}
          {isAssertionExportable(manifest.status) && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setExportMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium disabled:cursor-wait disabled:opacity-80"
                style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
              >
                {exportError ? 'Export failed' : 'Export Evaluation'}
                <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>▾</span>
              </button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border py-1 text-xs shadow-lg"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportEvaluation('raw')}
                  className="block w-full px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="block font-medium">Raw output</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Fast report, no LLM rewrite</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportEvaluation('localized')}
                  className="block w-full px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="block font-medium">Localized output</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Uses the LLM rewrite</span>
                </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-xs">
        <dt style={{ color: 'var(--text-muted)' }}>Feature</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={manifest.feature}>{manifest.feature}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Envset</dt>
        <dd className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={manifest.env ?? ''}>{manifest.env ?? '-'}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Duration</dt>
        <dd style={{ color: 'var(--text-primary)' }}>{duration == null ? 'in progress' : formatDuration(duration)}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Started</dt>
        <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.startedAt}>{manifest.startedAt}</dd>
        {manifest.endedAt && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Ended</dt>
            <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.endedAt}>{manifest.endedAt}</dd>
          </>
        )}
        {manifest.healCycles > 0 && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Heal cycles</dt>
            <dd style={{ color: 'var(--text-secondary)' }}>{manifest.healCycles}</dd>
          </>
        )}
        {healAgentOverviewLabel(manifest) && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Heal agent</dt>
            <dd className="truncate" style={{ color: 'var(--text-secondary)' }} title={healAgentOverviewLabel(manifest) ?? undefined}>
              {healAgentOverviewLabel(manifest)}
            </dd>
          </>
        )}
        {manifest.lifecycle && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>State</dt>
            <dd style={{ color: 'var(--text-secondary)' }}>{view.headline}</dd>
          </>
        )}
      </dl>
      <div className="mt-4">
        <SectionHeader>Services</SectionHeader>
        {services.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
        ) : (
          <ul className="space-y-2">
            {services.map((s) => (
              <ServiceCard key={s.safeName} service={s} branch={branchForService(s, repoBranches)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function healAgentOverviewLabel(manifest: RunManifest): string | null {
  if (manifest.healMode === 'external' && manifest.externalHealSession) {
    return externalHealClientLabel(manifest.externalHealSession.clientKind)
  }
  if (manifest.healAgent === 'claude') return 'Claude'
  if (manifest.healAgent === 'codex') return 'Codex'
  if (manifest.healMode === 'manual') return 'Manual'
  if (manifest.healMode === 'external') return 'External client'
  if (manifest.healMode === 'auto') return 'Auto'
  return null
}

function externalHealClientLabel(kind: RunManifest['externalHealSession']['clientKind']): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return 'External client'
  }
}

function VerifyOverviewTab({
  manifest,
  view,
}: {
  manifest: RunManifest
  view: RunViewModel
}) {
  const duration = durationBetween(manifest.startedAt, manifest.endedAt)
  const verification = manifest.verification
  const targets = verification?.targets ?? []
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4 text-sm">
      <div className="mb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          Verify
        </h2>
      </div>
      <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-y-1.5 text-xs">
        <dt style={{ color: 'var(--text-muted)' }}>Feature</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={manifest.feature}>{manifest.feature}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Configuration</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={verification?.configName ?? 'Unsaved'}>{verification?.configName ?? 'Unsaved'}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Playwright envset</dt>
        <dd className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={verification?.playwrightEnvsetId ?? manifest.env ?? ''}>{verification?.playwrightEnvsetId ?? manifest.env ?? '-'}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Duration</dt>
        <dd style={{ color: 'var(--text-primary)' }}>{duration == null ? 'in progress' : formatDuration(duration)}</dd>
        <dt style={{ color: 'var(--text-muted)' }}>Started</dt>
        <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.startedAt}>{manifest.startedAt}</dd>
        {manifest.endedAt && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>Ended</dt>
            <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.endedAt}>{manifest.endedAt}</dd>
          </>
        )}
      </dl>
      {view.primaryAlert && (
        <div className={`mt-4 rounded-md border px-2.5 py-2 text-xs ${alertClass(view.primaryAlert.tone)}`}>
          {view.primaryAlert.message}
        </div>
      )}
      <div className="mt-4 rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
        Verify is observational only. Canary Lab did not start local services or heal code.
      </div>
      <div className="mt-4">
        <SectionHeader>Services</SectionHeader>
        {targets.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No target services recorded.</div>
        ) : (
          <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-default)' }}>
            <div className="grid grid-cols-[180px_minmax(0,1fr)] border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
              <div>Service</div>
              <div>URL</div>
            </div>
            {targets.map((target) => (
              <div key={target.id} className="grid grid-cols-[180px_minmax(0,1fr)] gap-3 border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: 'var(--border-default)' }}>
                <div className="truncate" style={{ color: 'var(--text-primary)' }} title={target.name}>{target.name}</div>
                <div className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={target.url}>{target.url || '-'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RunLogsTab({ view, summary }: { view: RunViewModel; summary?: RunSummary }) {
  if (view.recoveryTimeline.length === 0) {
    return (
      <EmptyPane
        title="No run logs yet."
        body="Lifecycle events will appear here once Canary Lab records service startup, test execution, recovery, or final status."
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4 text-sm">
      <div className="mb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          Run Logs
        </h2>
      </div>
      <RecoveryTimeline
        events={view.recoveryTimeline}
        alert={view.primaryAlert}
        summary={summary}
      />
    </div>
  )
}

// Run has reached a terminal state — the agent pty is gone, so the live
// xterm pane has nothing to subscribe to. Switch to the structured-view
// historical replay (which reads the agent CLI's own JSONL session log).
export function isTerminalRunStatus(status: string): boolean {
  return isSharedTerminalRunStatus(status)
}

export function isAssertionExportable(status: string): boolean {
  return isSharedTerminalRunStatus(status)
}

export function isEvaluationExportable(status: string): boolean {
  return isAssertionExportable(status)
}

export function assertionFilename(feature: string, runId: string): string {
  return evaluationFilename(feature, runId)
}

export function assertionHref(runId: string): string {
  return evaluationHref(runId)
}

export function evaluationFilename(feature: string, runId: string): string {
  return `canary-lab-evaluation-${safeFilename(feature)}-${safeFilename(runId)}.zip`
}

export function evaluationHref(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/evaluation.html`
}

export async function downloadEvaluationReport(
  feature: string,
  runId: string,
  opts: {
    fetchImpl?: typeof fetch
    documentRef?: Document
    urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const documentRef = opts.documentRef ?? document
  const urlApi = opts.urlApi ?? URL
  const res = await fetchImpl(evaluationHref(runId))
  if (!res.ok) throw new Error(`evaluation export failed: HTTP ${res.status}`)
  const href = urlApi.createObjectURL(await res.blob())
  const link = documentRef.createElement('a')
  try {
    link.href = href
    link.download = evaluationFilename(feature, runId)
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    urlApi.revokeObjectURL(href)
  }
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
  summary,
  diagnostics,
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
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="cl-panel-header flex gap-1 px-3 py-1.5 text-xs">
        <SegmentButton active={view === 'terminal'} onClick={() => onViewChange('terminal')}>Terminal</SegmentButton>
        <SegmentButton active={view === 'playback'} onClick={() => onViewChange('playback')}>Playback</SegmentButton>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'terminal' && <PaneTerminal runId={runId} paneId="playwright" />}
        {view === 'playback' && (
          <div className="h-full overflow-y-auto scrollbar-thin" style={{ background: 'var(--bg-base)' }}>
            {diagnostics && <VerificationDiagnosticsPanel diagnostics={diagnostics} />}
            <PlaywrightPlayback events={events} artifactGroups={artifactGroups} artifactPolicy={artifactPolicy} onOpenArtifactSettings={onOpenArtifactSettings} summary={summary} embedded />
          </div>
        )}
      </div>
    </div>
  )
}

function VerificationDiagnosticsPanel({ diagnostics }: { diagnostics: VerificationDiagnostics }) {
  return (
    <div className="border-b p-3 text-xs" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}>
      <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
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

function DiagnosticList({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md p-2" style={{ background: 'var(--bg-selected)' }}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</div>
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap scrollbar-thin" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
        {lines.join('\n')}
      </pre>
    </div>
  )
}

function RecoveryTimeline({
  events,
  alert,
  summary,
}: {
  events: RunLifecycleEvent[]
  alert?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }
  summary?: RunSummary
}) {
  const now = useTimelineNow(events)
  return (
    <div>
      {alert && (
        <div className={`mb-2 rounded-md border px-2.5 py-2 text-xs ${alertClass(alert.tone)}`}>
          {alert.message}
        </div>
      )}
      <ol className="space-y-2">
        {events.map((event, idx) => {
          const durationLabel = lifecycleDurationLabel(events, idx, now)
          const showRunningTest = idx === events.length - 1 && summary?.running && isPlaywrightLifecyclePhase(event.phase)
          return (
            <li key={event.id ?? `${event.updatedAt}:${idx}`} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2 text-xs">
              <span className={`mt-1.5 h-2 w-2 rounded-full ${dotClass(event.severity)}`} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  <time
                    className="shrink-0 tabular-nums text-[10px]"
                    dateTime={event.updatedAt}
                    title={formatLifecycleDateTime(event.updatedAt)}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {formatLifecycleTime(event.updatedAt)}
                  </time>
                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{event.headline}</span>
                  {durationLabel && (
                    <span className="shrink-0 tabular-nums text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {durationLabel}
                    </span>
                  )}
                </span>
                {event.detail && <span className="block" style={{ color: 'var(--text-muted)' }}>{event.detail}</span>}
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
          )
        })}
      </ol>
    </div>
  )
}

function useTimelineNow(events: RunLifecycleEvent[]): number {
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

function formatLifecycleTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(time))
}

function formatLifecycleDateTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(time))
}

function lifecycleDurationLabel(events: RunLifecycleEvent[], idx: number, now: number): string | null {
  const start = Date.parse(events[idx]?.updatedAt ?? '')
  if (!Number.isFinite(start)) return null
  const next = events[idx + 1]
  if (next) {
    const end = Date.parse(next.updatedAt)
    if (!Number.isFinite(end) || end < start) return null
    return `took ${formatDuration(end - start)}`
  }
  if (isTerminalLifecyclePhase(events[idx].phase)) return null
  return `for ${formatDuration(Math.max(0, now - start))}`
}

function isTerminalLifecyclePhase(phase: RunLifecycleEvent['phase']): boolean {
  return phase === 'passed' || phase === 'failed' || phase === 'aborted' || phase === 'completed'
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
  summary,
  embedded = false,
}: {
  events?: PlaywrightPlaybackEvent[]
  artifactGroups?: PlaywrightArtifactGroup[]
  artifactPolicy?: PlaywrightArtifactPolicy
  onOpenArtifactSettings?: () => void
  summary?: RunSummary
  embedded?: boolean
}) {
  const tests = playbackTests(events)
  if (tests.length === 0) {
    return <EmptyPane title="No playback events captured yet." body="Use Terminal for older runs or runs that ended before structured Playwright events were written." />
  }
  const activeIndex = currentPlaybackIndex(tests, summary?.running?.name)
  return (
    <div className={`${embedded ? '' : 'h-full overflow-y-auto scrollbar-thin'} p-3 text-xs`} style={{ background: 'var(--bg-base)' }}>
      <div className="space-y-2">
        {tests.map((test, idx) => {
          const playbackArtifacts = artifactsForPlayback(test.name, artifactGroups, artifactPolicy)
          const traceArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'trace')
          const videoArtifacts = playbackArtifacts.links.filter((artifact) => artifact.kind === 'video')
          const isCurrent = idx === activeIndex
          return (
            <div
              key={`${test.name}:${test.retry ?? 0}:${test.startedAt ?? ''}`}
              className="cl-card p-3"
            >
              <div className="flex min-w-0 flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <PlaybackHeader test={test} current={isCurrent} index={idx} total={tests.length} />
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

function TraceActions({ artifacts }: { artifacts: PlaywrightArtifact[] }) {
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

function PlaybackHeader({
  test,
  current,
  index,
  total,
}: {
  test: PlaybackTest
  current: boolean
  index: number
  total: number
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <StatusPill passed={test.passed} status={test.status} current={current} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate font-medium" style={{ color: 'var(--text-primary)' }} title={test.title}>
            {test.title}
          </div>
          <span className="shrink-0 rounded px-1 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: current ? 'var(--accent)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {index + 1}/{total}
          </span>
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
                {!step.ended && <span style={{ color: 'var(--warning)' }}> (running)</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function StatusPill({ passed, status, current }: { passed?: boolean; status?: string; current?: boolean }) {
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

function currentPlaybackIndex(tests: PlaybackTest[], runningName?: string): number {
  if (!runningName) return -1
  for (let i = tests.length - 1; i >= 0; i--) {
    if (tests[i].name === runningName && !tests[i].endedAt) return i
  }
  for (let i = tests.length - 1; i >= 0; i--) {
    if (tests[i].name === runningName) return i
  }
  return -1
}

function isPlaywrightLifecyclePhase(phase: RunLifecycleEvent['phase']): boolean {
  return phase === 'running-tests' || phase === 'rerunning-tests'
}

function formatSummaryTestName(name: string): string {
  return name.replace(/^test-case-/, '').replace(/-/g, ' ')
}

export function shortLocation(location: string): string {
  const parts = location.split('/')
  return parts.slice(-2).join('/')
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </h2>
  )
}

const STATUS_COLOR: Record<ServiceStatus, string> = {
  ready: 'var(--success)',
  starting: 'var(--warning)',
  timeout: 'var(--danger)',
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
  const labelParts = serviceTabLabelParts(service, branch)
  return (
    <button
      type="button"
      onClick={onClick}
      title={branch ? branchTooltip(service, branch) : labelParts.primary}
      className={`cl-tab flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      <ServiceStatusDot status={service.status} />
      <span className="max-w-[150px] truncate">{labelParts.primary}</span>
      {labelParts.branch && (
        <span className="max-w-[120px] truncate rounded px-1 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: branch?.dirty ? '#f59e0b' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          @ {labelParts.branch}
        </span>
      )}
    </button>
  )
}

function ServiceCard({
  service,
  branch,
}: {
  service: ServiceManifestEntry
  branch: RepoBranchSnapshot | null
}) {
  const primaryLabel = servicePrimaryLabel(service, branch?.name)
  return (
    <li className="cl-card p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{primaryLabel}</div>
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
        {branch && <BranchRow branch={branch} />}
        <ServiceField label="log" value={service.logPath} />
        {service.healthUrl && <ServiceField label="url" value={service.healthUrl} href={service.healthUrl} />}
      </div>
    </li>
  )
}

function BranchRow({ branch }: { branch: RepoBranchSnapshot }) {
  const value = branch.detached ? 'detached HEAD' : branch.branch ?? 'unknown'
  const mismatch = Boolean(branch.expectedBranch && branch.branch !== branch.expectedBranch)
  const onCopy = () => {
    void navigator.clipboard?.writeText(value)
  }
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>ref</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
          title={value}
        >
          {value}
        </span>
        {branch.dirty && (
          <span
            className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider"
            style={{ background: 'var(--bg-selected)', color: '#f59e0b' }}
          >
            dirty
          </span>
        )}
        {mismatch && (
          <span
            className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider"
            style={{ background: 'var(--bg-selected)', color: '#f59e0b' }}
            title={`expected ${branch.expectedBranch}`}
          >
            ≠ {branch.expectedBranch}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy branch"
          title="Copy branch"
          className="cl-icon-button h-5 w-5"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </span>
    </>
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
    status === 'ready' ? 'var(--success)'      // green
    : status === 'starting' ? 'var(--warning)' // yellow (pulses)
    : status === 'timeout' ? 'var(--danger)'  // red
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
      className={`cl-tab shrink-0 whitespace-nowrap px-2 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}
