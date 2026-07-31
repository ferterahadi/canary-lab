import { useEffect, useMemo, useState } from 'react'
import type { AuditEntry, RepoBranchSnapshot, ServiceManifestEntry, RunManifest, RunStatus, RunSummary } from '@/shared/api/types'
import { getRunAudit } from '@/shared/api/client'
import { formatDuration, durationBetween } from '@/shared/lib/format'
import { buildTimelineRows } from '../utils/run-timeline'
import { branchForService, branchLabel } from '../utils/run-detail-playback'
import { type RunViewModel } from '../utils/run-view-model'
import { isRestartableRunStatus } from '@shared/run-state'
import { RecoveryTimeline, alertClass, useTimelineNow } from './RunDiagnosticsPanels'
import { EmptyGlyph } from '@/shared/ui/EmptyState'
import { ReviewEvaluationMenu } from './ReviewEvaluationMenu'
import { RunPane } from './RunPane'
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
  // The "Review Evaluation" trigger moved to the run's tab row
  // (`ReviewEvaluationMenu`) — it is a run-level action, not an Overview one.
  return (
    <RunPane padded>
      {/* The run's facts read down the left; the deliverable sits in the gutter
          they leave empty on the right. It is the one thing you *do* from this
          pane, so it belongs beside the facts rather than in the chrome above,
          where a fixed-width button squeezed the tab row on a narrow panel. */}
      <div className="flex items-start gap-4">
        <dl className="grid min-w-0 flex-1 grid-cols-[92px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="cl-rubric self-center">Feature</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={manifest.feature}>{manifest.feature}</dd>
        <dt className="cl-rubric self-center">Envset</dt>
        <dd className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={manifest.env ?? ''}>{manifest.env ?? '-'}</dd>
        <dt className="cl-rubric self-center">Duration</dt>
        <dd style={{ color: 'var(--text-primary)' }}>{duration == null ? 'in progress' : formatDuration(duration)}</dd>
        <dt className="cl-rubric self-center">Started</dt>
        <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.startedAt}>{manifest.startedAt}</dd>
        {manifest.endedAt && (
          <>
            <dt className="cl-rubric self-center">Ended</dt>
            <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.endedAt}>{manifest.endedAt}</dd>
          </>
        )}
        {manifest.healCycles > 0 && (
          <>
            <dt className="cl-rubric self-center">Heal cycles</dt>
            <dd style={{ color: 'var(--text-secondary)' }}>{manifest.healCycles}</dd>
          </>
        )}
        {healAgentOverviewLabel(manifest) && (
          <>
            <dt className="cl-rubric self-center">Heal agent</dt>
            <dd className="truncate" style={{ color: 'var(--text-secondary)' }} title={healAgentOverviewLabel(manifest) ?? undefined}>
              {healAgentOverviewLabel(manifest)}
            </dd>
          </>
        )}
        {/* No `State` row: the run's verdict is already the status badge in the
            run header a few pixels above, and "Run passed" under a green PASSED
            chip is the same fact told twice. Anything the headline says that the
            badge cannot (a held boot session, a recovery note) arrives as the
            alert below or in the Run Logs timeline. */}
        </dl>
        {isAssertionExportable(manifest.status) && (
          <div className="shrink-0"><ReviewEvaluationMenu runId={manifest.runId} /></div>
        )}
      </div>
      {/* For a boot-only session the held-state message is the point of the
          screen, so surface it on the overview (normal runs keep it in the
          Run Logs timeline only). */}
      {manifest.executionType === 'boot' && view.primaryAlert && (
        <div className={`mt-4 rounded-md border px-2.5 py-2 text-xs ${alertClass(view.primaryAlert.tone)}`}>
          {view.primaryAlert.message}
        </div>
      )}
      <div className="mt-4">
        {/* No `Services` heading: a stack of named service cards is self-evident,
            and the label was one more line of chrome between the run's facts and
            the thing they describe. The boot-session hint still needs saying. */}
        {manifest.executionType === 'boot' && services.length > 0 && (
          <SectionHeader>Open to exercise</SectionHeader>
        )}
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
    </RunPane>
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
    <RunPane padded>
      <dl className="grid grid-cols-[118px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="cl-rubric self-center">Feature</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={manifest.feature}>{manifest.feature}</dd>
        <dt className="cl-rubric self-center">Configuration</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={verification?.configName ?? 'Unsaved'}>{verification?.configName ?? 'Unsaved'}</dd>
        <dt className="cl-rubric self-center">Playwright envset</dt>
        <dd className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={verification?.playwrightEnvsetId ?? manifest.env ?? ''}>{verification?.playwrightEnvsetId ?? manifest.env ?? '-'}</dd>
        <dt className="cl-rubric self-center">Duration</dt>
        <dd style={{ color: 'var(--text-primary)' }}>{duration == null ? 'in progress' : formatDuration(duration)}</dd>
        <dt className="cl-rubric self-center">Started</dt>
        <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.startedAt}>{manifest.startedAt}</dd>
        {manifest.endedAt && (
          <>
            <dt className="cl-rubric self-center">Ended</dt>
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
            <div className="grid grid-cols-[180px_minmax(0,1fr)] border-b px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
              <div className="cl-rubric">Service</div>
              <div className="cl-rubric">URL</div>
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
    </RunPane>
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

  return (
    <RunPane padded>
      {rows.length === 0 ? (
        <EmptyPane
          icon={EmptyGlyph.timeline}
          title="No lifecycle events yet"
          body="Canary Lab records one row per moment that matters — a service coming up, the test process starting, a recovery attempt, the final verdict. The first one lands as soon as this run does something."
        />
      ) : (
        <RecoveryTimeline
          rows={rows}
          /* A `success` alert only ever says "Run passed." — which the header
             badge says above and the timeline's own last row says below. Only
             alerts that carry something the rest of the pane cannot (a failure
             reason, an abort, a held boot session) earn the banner. */
          {...(view.primaryAlert && view.primaryAlert.tone !== 'success' ? { alert: view.primaryAlert } : {})}
          {...(summary ? { summary } : {})}
        />
      )}
    </RunPane>
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
