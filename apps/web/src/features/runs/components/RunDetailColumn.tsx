import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunStatus } from '@/shared/api/types'
import { branchForService } from '../utils/run-detail-playback'
import { useRun } from '../state/RunsContext'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { deriveRunViewModel } from '../utils/run-view-model'
import { RunStatusIndicator } from './RunStatusIndicator'
import { PaneTerminal } from './PaneTerminal'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { ExternalHealPanel } from './ExternalHealPanel'
import { ChangesTab } from './ChangesTab'
import { JournalTab } from './JournalTab'
import { ManualHealBanner } from './ManualHealBanner'
import { PlaywrightPanel } from './RunDiagnosticsPanels'
import { RunLogsTab, RunOverviewTab, VerifyOverviewTab, repoServiceCount } from './RunOverviewTabs'
import { RunPane } from './RunPane'
import type { PlaywrightView } from './RunPlaybackPanels'
import { ServiceTabButton, TabButton } from './RunServicePanels'
import { isTerminalRunStatus } from './run-export-links'

export { canRestartHeal, repoServiceCount, servicePrimaryLabel, serviceTabLabelParts } from './RunOverviewTabs'
export { PlaywrightPlayback, shortLocation } from './RunPlaybackPanels'
export { assertionFilename, assertionHref, downloadEvaluationReport, evaluationFilename, evaluationHref, hasAssertionVideos, isAssertionExportable, isEvaluationExportable, isTerminalRunStatus } from './run-export-links'

type Tab = 'overview' | 'run-logs' | 'services' | 'playwright' | 'agent' | 'changes' | 'journal'

/** Why this run has no repair transcript. A run that passed never spawned an
 *  agent at all — saying so is the whole answer, where "no structured session
 *  log found" reads as a missing file the user should go hunting for. */
export function healEmptyCopy(status: RunStatus, healCycles: number): { title: string; body: string; tone: 'neutral' | 'good' } {
  if (healCycles === 0 && status === 'passed') {
    return {
      title: 'No repairs needed',
      body: 'Every test passed on the first attempt, so no repair agent was ever started. Nothing was changed in your code.',
      tone: 'good',
    }
  }
  if (healCycles === 0) {
    return {
      title: 'No repair agent ran',
      body: 'This run ended before a repair cycle started — it was aborted, or heal is switched off for this feature.',
      tone: 'neutral',
    }
  }
  return {
    title: 'Transcript unavailable',
    body: `This run went through ${healCycles} repair ${healCycles === 1 ? 'cycle' : 'cycles'}, but the agent CLI left no readable session file. The Journal tab still holds what each cycle concluded.`,
    tone: 'neutral',
  }
}

export function RunDetailColumn({
  runId,
  onOpenPlaywrightSettings,
  totalTests,
  focusTest,
}: {
  runId: string | null
  onOpenPlaywrightSettings?: (feature: string) => void
  totalTests?: number
  /** R82: a failing test to land on — the run-summary failed-entry `name` a
   *  flight's Test Run stage was clicked on. Opens the Playwright tab and scrolls
   *  that test's card into view. Routed as `?run=…&test=…`, so a refresh or a
   *  pasted link lands in the same place. */
  focusTest?: string
}) {
  // The journal refetches on `journal-changed` for THIS run (scoped so a bump
  // for another run doesn't reload it).
  const journalRefreshKey = useInvalidationKey('journal', runId ?? undefined)
  // Arriving with a focused failure means the Playwright tab IS the destination —
  // opening on Overview would hide the thing that was clicked.
  const [tab, setTab] = useState<Tab>(focusTest ? 'playwright' : 'overview')
  const [serviceIdx, setServiceIdx] = useState(0)
  const [playwrightView, setPlaywrightView] = useState<PlaywrightView>('playback')
  const [agentPaneRestartKey, setAgentPaneRestartKey] = useState(0)
  const [agentPaneExited, setAgentPaneExited] = useState(false)
  const currentRunStatusRef = useRef<RunStatus | undefined>(undefined)

  // Detail comes from the WebSocket-backed RunsContext. No polling here —
  // the same `state.details[runId]` populated for the runs list is reused,
  // so the header badge flips status the instant the server pushes the
  // next `update` frame. The transient action (e.g. user clicked Stop in
  // the runs list) is overlaid into `displayStatus` so this header shows
  // `ABORTING` mid-action instead of stale `RUNNING`.
  const { detail, transient } = useRun(runId)
  const handleAgentPaneExit = useCallback(() => {
    if (currentRunStatusRef.current === 'healing') return
    setAgentPaneExited(true)
  }, [])

  useEffect(() => {
    setAgentPaneExited(false)
  }, [runId, agentPaneRestartKey])

  useEffect(() => {
    currentRunStatusRef.current = detail?.manifest.status
    if (detail?.manifest.status === 'healing') {
      setAgentPaneExited(false)
    }
  }, [detail?.manifest.status])

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

  const executionType = detail?.manifest.executionType ?? 'run'
  const isVerifyRun = executionType === 'verify'
  const isBootRun = executionType === 'boot'
  // A later focus (clicking a second failure while this run is already open)
  // switches back to the tab that can show it.
  useEffect(() => {
    if (focusTest) setTab('playwright')
  }, [focusTest, runId])
  useEffect(() => {
    if (isVerifyRun && tab !== 'overview' && tab !== 'playwright') setTab('overview')
    // A boot-only session has no Playwright / heal / journal — keep the user on
    // the tabs that exist (overview, run logs, services).
    if (isBootRun && tab !== 'overview' && tab !== 'run-logs' && tab !== 'services') setTab('overview')
  }, [isVerifyRun, isBootRun, tab])

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
            <RunStatusIndicator status={view.displayStatus} executionType={executionType} />
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
              background: isVerify ? 'var(--accent-soft)' : isBootRun ? 'var(--boot-soft)' : 'var(--bg-selected)',
              color: isVerify ? 'var(--accent)' : isBootRun ? 'var(--boot)' : 'var(--text-muted)',
              letterSpacing: '0.04em',
            }}
          >
            {isVerify ? 'Verify' : isBootRun ? 'Boot' : 'Run'}
          </span>
          <span
            className="min-w-0 shrink truncate text-xs"
            title={m.feature}
            style={{ color: 'var(--text-muted)' }}
          >
            {m.feature}
          </span>
        </div>
        <nav className="mt-3 flex gap-5 overflow-x-auto scrollbar-none">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          {!isVerify && <TabButton active={tab === 'run-logs'} onClick={() => setTab('run-logs')}>Run Logs</TabButton>}
          {!isVerify && <TabButton active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0}>Services</TabButton>}
          {!isBootRun && <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>}
          {!isVerify && !isBootRun && <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>Heal agent</TabButton>}
          {/* What the repair actually changed. Disabled rather than hidden when
              a run changed nothing, so its absence reads as "no edits" instead
              of a tab that moved. */}
          {!isVerify && !isBootRun && (
            <TabButton
              active={tab === 'changes'}
              onClick={() => setTab('changes')}
              disabled={!m.fixCapture || m.fixCapture.repos.length === 0}
            >
              Changes
            </TabButton>
          )}
          {!isVerify && !isBootRun && <TabButton active={tab === 'journal'} onClick={() => setTab('journal')}>Journal</TabButton>}
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
          <RunLogsTab view={view} summary={detail.summary} runId={m.runId} runStatus={m.status} />
        )}
        {!isVerify && tab === 'services' && services.length > 0 && (
          <RunPane
            scroll={false}
            bar={
              <>
                {services.map((s, i) => (
                  <ServiceTabButton
                    key={s.safeName}
                    service={s}
                    branch={branchForService(s, repoBranches)}
                    active={i === serviceIdx}
                    onClick={() => setServiceIdx(i)}
                    siblings={repoServiceCount(s, services)}
                  />
                ))}
              </>
            }
          >
            {activeService && (
              <PaneTerminal
                runId={m.runId}
                paneId={`service:${activeService.safeName}`}
                emptyState={{ title: 'Nothing logged yet', hint: 'This service’s stdout and stderr stream here the moment it writes its first line.' }}
              />
            )}
          </RunPane>
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
            totalTests={totalTests}
            {...(focusTest ? { focusTest } : {})}
          />
        )}
        {/* Always rendered, hidden via display:none when another tab is active.
            Keeps the live xterm + WebSocket alive so the Ink-based heal agent
            TUI isn't replayed from scratch on tab return — replaying the raw
            stream re-executes every clear-screen redraw and collapses scrollback
            to the last frame. */}
        {!isVerify && <div hidden={tab !== 'agent'} className="h-full min-h-0">
          {/* One flex column, not a banner beside a `h-full` block: the pane's
              wrapper clips at its own height, so a `h-full` agent view under a
              banner overflowed by exactly the banner's height and cut that much
              off the bottom of the transcript. */}
          <RunPane scroll={false}>
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {m.healMode === 'manual' && view.actions.cancelHeal.enabled && m.signalPaths && (
                <div className="shrink-0">
                  <ManualHealBanner runId={m.runId} signalPaths={m.signalPaths} />
                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                <AgentSessionView
                  source={{ kind: 'run', runId: m.runId, live: !isTerminalRunStatus(m.status) }}
                  empty={healEmptyCopy(m.status, m.healCycles)}
                />
              ) : (
                <PaneTerminal
                  key={`${m.runId}:agent:${agentPaneRestartKey}`}
                  runId={m.runId}
                  paneId="agent"
                  onExit={handleAgentPaneExit}
                  emptyState={{ title: 'No repair agent running', hint: 'If the tests fail, the agent starts here and its reasoning streams live.' }}
                />
              )}
              </div>
            </div>
            {/* Retest lives as a per-row icon in RunsColumn now (see
                RetestIconButton). The footer-bar variant that used to sit here
                duplicated that affordance. */}
          </RunPane>
        </div>}
        {!isVerify && !isBootRun && tab === 'changes' && (
          // No wrapper scroller: the tab renders its own `RunPane`, the same
          // frame every other tab uses. The extra `overflow-auto` div around it
          // made this the one pane with two nested scrollers.
          <ChangesTab
            runId={m.runId}
            fixCapture={m.fixCapture}
            proposedPrs={m.proposedPrs}
            prAttempt={m.prAttempt}
            repoBranches={repoBranches}
          />
        )}
        {!isVerify && tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} refreshKey={journalRefreshKey} healCycles={m.healCycles} />
        )}
      </div>
    </div>
  )
}
