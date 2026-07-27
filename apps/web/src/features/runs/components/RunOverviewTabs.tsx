import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuditEntry, EvaluationExportMode, RepoBranchSnapshot, ServiceManifestEntry, RunManifest, RunStatus, RunSummary } from '@/shared/api/types'
import { getRunAudit } from '@/shared/api/client'
import { formatDuration, durationBetween } from '@/shared/lib/format'
import { buildTimelineRows } from '../utils/run-timeline'
import { branchForService, branchLabel } from '../utils/run-detail-playback'
import { useEvaluationExports } from '@/features/evaluation'
import { useMcpPromo } from '@/shared/shell/McpPromoContext'
import { type RunViewModel } from '../utils/run-view-model'
import { isRestartableRunStatus } from '@shared/run-state'
import { RecoveryTimeline, alertClass, useTimelineNow } from './RunDiagnosticsPanels'
import { EmptyPane, SectionHeader } from './RunPlaybackPanels'
import { ServiceCard } from './RunServicePanels'
import { isAssertionExportable, isTerminalRunStatus } from './run-export-links'

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

export interface RunOverviewTabProps {
  manifest: RunManifest
  view: RunViewModel
  services: ServiceManifestEntry[]
  repoBranches: RepoBranchSnapshot[]
}

export function RunOverviewTab({
  manifest,
  view,
  services,
  repoBranches,
}: RunOverviewTabProps) {
  const duration = durationBetween(manifest.startedAt, manifest.endedAt)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportError, setExportError] = useState(false)
  const { startExport } = useEvaluationExports()
  const { gatePromo } = useMcpPromo()
  // R38: run detail keeps only the "Review Evaluation" trigger — the export's
  // progress/output is watched via the Flights pill (it blinks on an active
  // export) and the flight's Evaluation Report stage, not inline here.
  const handleExportEvaluation = useCallback(async (mode: EvaluationExportMode) => {
    setExportMenuOpen(false)
    setExportError(false)
    gatePromo('export-evaluation', () => {
      void Promise.resolve(startExport(manifest.runId, mode))
        .catch(() => setExportError(true))
    })
  }, [gatePromo, manifest.runId, startExport])

  return (
    <div className="h-full overflow-y-auto scrollbar-none p-4 text-sm">
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
                title="Produce the evaluation report and review it — per-test reasoning + verdicts, with video playback where the tests drive a browser. This is the run's deliverable."
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium disabled:cursor-wait disabled:opacity-80"
                style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
              >
                {exportError ? 'Export failed' : '📊 Review Evaluation'}
                <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>▾</span>
              </button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="cl-popover absolute right-0 z-20 mt-1 w-44 overflow-hidden py-1 text-xs"
                  style={{ color: 'var(--text-primary)' }}
                >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportEvaluation('raw')}
                  className="cl-hover-row block w-full px-3 py-2 text-left"
                >
                  <span className="block font-medium">Raw output</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Fast report, no LLM rewrite</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportEvaluation('localized')}
                  className="cl-hover-row block w-full px-3 py-2 text-left"
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
      {/* For a boot-only session the held-state message is the point of the
          screen, so surface it on the overview (normal runs keep it in the
          Run Logs timeline only). */}
      {manifest.executionType === 'boot' && view.primaryAlert && (
        <div className={`mt-4 rounded-md border px-2.5 py-2 text-xs ${alertClass(view.primaryAlert.tone)}`}>
          {view.primaryAlert.message}
        </div>
      )}
      <div className="mt-4">
        <SectionHeader>{manifest.executionType === 'boot' ? 'Services (open to exercise)' : 'Services'}</SectionHeader>
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

export function healAgentOverviewLabel(manifest: RunManifest): string | null {
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

export function externalHealClientLabel(kind: NonNullable<RunManifest['externalHealSession']>['clientKind']): string {
  switch (kind) {
    case 'claude': return 'Claude'
    case 'codex': return 'Codex'
    case 'claude-pty': return 'Claude (runner)'
    case 'codex-pty': return 'Codex (runner)'
    case 'other': return 'External client'
  }
}

export function VerifyOverviewTab({
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
    <div className="h-full overflow-y-auto scrollbar-none p-4 text-sm">
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

export function RunLogsTab({
  view,
  summary,
  runId,
  runStatus,
}: {
  view: RunViewModel
  summary?: RunSummary
  runId: string
  runStatus: RunStatus
}) {
  const audit = useExternalAudit(runId, runStatus)
  const now = useTimelineNow(view.recoveryTimeline)
  const rows = useMemo(
    () => buildTimelineRows(view.recoveryTimeline, audit, { now }),
    [view.recoveryTimeline, audit, now],
  )

  if (rows.length === 0) {
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
      <RecoveryTimeline rows={rows} alert={view.primaryAlert} summary={summary} />
    </div>
  )
}

// External MCP commands are appended to `<runDir>/external-commands.jsonl`. Tail
// it via /api/runs/:runId/audit so the heal-loop story interleaves with the
// orchestrator's own lifecycle events. Poll every 2s while the run is active;
// for terminal runs the log is final, so one read suffices. Best-effort: a
// fetch error just means no external rows, never a broken Run Logs pane.
export function useExternalAudit(runId: string, runStatus: RunStatus): AuditEntry[] {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const terminal = isTerminalRunStatus(runStatus)

  useEffect(() => {
    let cancelled = false
    const fetchAudit = async (): Promise<void> => {
      try {
        const res = await getRunAudit(runId)
        if (!cancelled) setEntries(res.entries)
      } catch {
        // Audit is best-effort; leave prior entries in place on a transient error.
      }
    }
    void fetchAudit()
    if (terminal) return () => { cancelled = true }
    const id = window.setInterval(() => { void fetchAudit() }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [runId, terminal])

  return entries
}
