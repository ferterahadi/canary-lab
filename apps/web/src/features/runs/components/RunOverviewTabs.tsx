import { clientLabel } from '@/shared/ui/external-client-branding'
import { RecordedTestChanges } from './RecordedTestChanges'
import { pinnedPlanSummary } from '@shared/agent-models'
import { useMemo } from 'react'
import type { RepoBranchSnapshot, ServiceManifestEntry, RunManifest } from '@shared/run-manifest'
import type { RunSummary } from '@shared/run-detail'
import { useExternalAudit } from '../state/use-external-audit'
import { openRunLog } from '../utils/open-run-log'
import { BootEvidenceRows, bootEvidenceLabel } from '@/shared/ui/BootEvidence'
import { formatDuration, durationBetween } from '@/shared/lib/format'
import { buildTimelineRows } from '../utils/run-timeline'
import { branchForService, branchLabel } from '../utils/run-detail-playback'
import { type RunViewModel } from '../utils/run-view-model'
import { isRestartableRunStatus, type RunStatus } from '@shared/run-state'
import { RecoveryTimeline, alertClass, formatLifecycleDate, formatLifecycleTime, useTimelineNow } from './RunDiagnosticsPanels'
import { plural } from '@shared/lib/plural'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { ReviewEvaluationMenu } from './ReviewEvaluationMenu'
import { RunPane } from './RunPane'
import { SectionHeader } from './RunPlaybackPanels'
import { ServiceCard } from './RunServicePanels'
import { isAssertionExportable } from './run-export-links'

export function canRestartHeal(status: string): boolean {
  return isRestartableRunStatus(status)
}

/** How many services in this run come out of the same repo as `service`. One
 *  repo hosting several services makes its name shared context, not identity. */
export function repoServiceCount(
  service: Pick<ServiceManifestEntry, 'repoName'>,
  services: readonly Pick<ServiceManifestEntry, 'repoName'>[],
): number {
  return services.filter((s) => s.repoName === service.repoName).length
}

export function servicePrimaryLabel(
  service: Pick<ServiceManifestEntry, 'name' | 'repoName'>,
  repoNameFallback?: string | null,
  /** Siblings sharing this service's repo, including itself. */
  siblings = 1,
): string {
  // The repo name is the better identity for a one-service repo: service names
  // there are often the whole stack spelled out ("my-backend gateway stack").
  // But a repo hosting several services gives every card and tab the SAME
  // label — three cards all reading "storefront" tell you nothing about which
  // is catalog and which is checkout. Then the service name is the identity and
  // the repo is context the cwd and ref rows already carry.
  if (siblings > 1) return service.name
  return service.repoName?.trim() || repoNameFallback?.trim() || service.name
}

export function serviceTabLabelParts(
  service: Pick<ServiceManifestEntry, 'name' | 'repoName'>,
  branch: RepoBranchSnapshot | null,
  siblings = 1,
): { primary: string; branch: string | null } {
  return {
    primary: servicePrimaryLabel(service, branch?.name, siblings),
    branch: branch ? branchLabel(branch) : null,
  }
}

export interface RunOverviewTabProps {
  manifest: RunManifest
  view: RunViewModel
  services: ServiceManifestEntry[]
  repoBranches: RepoBranchSnapshot[]
  onCompareTests?: () => void
  onOpenEvaluationReport?: (feature: string) => void
  /** Opens the boot-failure dialog from the failing service's card. */
  onOpenBootFailure?: () => void
}

export function RunOverviewTab({
  manifest,
  view,
  services,
  repoBranches,
  onCompareTests,
  onOpenEvaluationReport,
  onOpenBootFailure = () => {},
}: RunOverviewTabProps) {
  const duration = durationBetween(manifest.startedAt, manifest.endedAt)
  const serviceOwnsBootFailure = Boolean(
    manifest.bootFailure
    && manifest.bootFailure.reason !== 'dependency-incompatible'
    && services.some((service) => service.safeName === manifest.bootFailure?.safeName),
  )
  const incompatibleRepos = new Set(
    manifest.dependencyProvenance?.filter((item) => item.verdict === 'incompatible').map((item) => item.repoName) ?? [],
  )
  const needsAttention = (service: ServiceManifestEntry) => (
    manifest.bootFailure?.safeName === service.safeName
    || manifest.serviceFailure?.safeName === service.safeName
    || incompatibleRepos.has(service.repoName ?? '')
  )
  // Preserve configured order within each group; only lift affected services
  // so a failure is never buried below healthy peers in a longer stack.
  const displayedServices = [
    ...services.filter(needsAttention),
    ...services.filter((service) => !needsAttention(service)),
  ]
  return (
    <RunPane padded>
      {/* The run's facts as one titled card of tiles — the same card anatomy
          (title strip, then body) as the service cards below it and the test
          cards on the Playwright tab. No Suite tile: the run header names the
          suite a few pixels above. No `State` tile either: the verdict is the
          header's status badge, and anything it cannot say (a held boot
          session, a recovery note) arrives as the alert below or in Run Logs.
          The deliverable sits on the strip's right: it is the one thing you
          *do* from this pane, and on the strip it never squeezes the tab row. */}
      <section className="cl-card overflow-hidden" data-testid="run-facts">
        <div className="cl-card-head">
          <h2 className="cl-rubric min-w-0 flex-1 truncate">At a glance</h2>
          {isAssertionExportable(manifest.status) && (
            <div className="-my-1 shrink-0">
              <ReviewEvaluationMenu
                runId={manifest.runId}
                onExportStarted={(task) => onOpenEvaluationReport?.(task.feature)}
              />
            </div>
          )}
        </div>
        {/* A label column beside a value column, one fact per row — the same
            reading order as a service card's cmd/cwd/url fields below. */}
        <dl className="cl-card-body grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
          {runFacts(manifest, duration).map((fact) => <RunFactRow key={fact.label} fact={fact} />)}
        </dl>
      </section>
      <RecordedTestChanges manifest={manifest} onCompare={onCompareTests} />
      {/* For a boot-only session the held-state message is the point of the
          screen, so surface it on the overview (normal runs keep it in the
          Run Logs timeline only). */}
      {manifest.executionType === 'boot' && view.primaryAlert && (
        <div className={`mt-4 rounded-md border px-2.5 py-2 text-xs ${alertClass(view.primaryAlert.tone)}`}>
          {view.primaryAlert.message}
        </div>
      )}
      {manifest.bootFailure && manifest.bootFailure.reason !== 'dependency-incompatible' && !serviceOwnsBootFailure && (
        <BootFailureEvidence runId={manifest.runId} failure={manifest.bootFailure} />
      )}
      {manifest.serviceFailure && <ServiceFailureEvidence runId={manifest.runId} failure={manifest.serviceFailure} />}
      <div className="mt-3">
        {/* No `Services` heading: a stack of named service cards is self-evident,
            and the label was one more line of chrome between the run's facts and
            the thing they describe. The boot-session hint still needs saying. */}
        {manifest.executionType === 'boot' && services.length > 0 && (
          <SectionHeader>Open to exercise</SectionHeader>
        )}
        {services.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
        ) : (
          <ul className="space-y-3">
            {displayedServices.map((s) => (
              <ServiceCard
                key={s.safeName}
                runId={manifest.runId}
                service={s}
                branch={branchForService(s, repoBranches)}
                siblings={repoServiceCount(s, services)}
                bootFailure={manifest.bootFailure?.safeName === s.safeName ? manifest.bootFailure : undefined}
                dependency={manifest.dependencyProvenance?.find((item) => item.repoName === s.repoName && item.verdict === 'incompatible')}
                onOpenBootFailure={onOpenBootFailure}
              />
            ))}
          </ul>
        )}
      </div>
    </RunPane>
  )
}

/** One row in the Overview's "At a glance" card. */
export interface RunFact {
  label: string
  value: string
  /** A second, quieter part — the date after a time, the cycle count after the agent. */
  sub?: string
  /** Hover text when the row shows a shortened form (the full ISO timestamp). */
  title?: string
  mono?: boolean
  /** No value recorded for this run: the row shows a muted dash. */
  empty?: boolean
}

const NO_VALUE = '—'

/** The run's facts, in a fixed order. Envset, duration and start always show —
 *  a run without an envset reads as a dash; the end time, heal and models rows
 *  appear once the run has recorded them. A timestamp splits into the time
 *  (what you compare between runs) and the date, with the exact ISO value on
 *  hover. The heal agent and its cycle count are one fact — who healed, and
 *  how many times. */
export function runFacts(manifest: RunManifest, duration: number | null): RunFact[] {
  const agent = healAgentOverviewLabel(manifest)
  const cycles = manifest.healCycles > 0 ? plural(manifest.healCycles, 'cycle') : null
  const heal = agent ?? cycles
  const models = pinnedPlanSummary(manifest.models)
  return [
    { label: 'Envset', value: manifest.env ?? NO_VALUE, mono: true, ...(manifest.env ? {} : { empty: true }) },
    { label: 'Duration', value: manifest.status === 'queued' ? 'Not started' : duration == null ? 'in progress' : formatDuration(duration) },
    timestampFact(manifest.status === 'queued' ? 'Queued at' : 'Started', manifest.startedAt),
    ...(manifest.endedAt ? [timestampFact('Ended', manifest.endedAt)] : []),
    ...(heal ? [{ label: 'Heal', value: heal, ...(agent && cycles ? { sub: cycles } : {}) }] : []),
    ...(models ? [{ label: 'Models', value: models, title: models }] : []),
  ]
}

function timestampFact(label: string, iso: string): RunFact {
  return { label, value: formatLifecycleTime(iso), sub: formatLifecycleDate(iso), title: iso, mono: true }
}

/** A row of the facts list: the rubric label in the left column, the value
 *  and its quieter sub in the right. `contents` lets the dt/dd pair sit in the
 *  parent grid's two columns while the row stays one addressable element. */
export function RunFactRow({ fact }: { fact: RunFact }) {
  const mono = fact.mono ? { fontFamily: 'var(--font-mono)' } : {}
  return (
    <div className="contents" data-testid="run-fact">
      <dt className="cl-rubric truncate">{fact.label}</dt>
      <dd
        className="flex min-w-0 items-baseline gap-1.5"
        title={fact.title ?? fact.value}
      >
        <span className="truncate" style={{ color: fact.empty ? 'var(--text-muted)' : 'var(--text-primary)', ...mono }}>
          {fact.value}
        </span>
        {fact.sub && (
          <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)', ...mono }}>
            {fact.sub}
          </span>
        )}
      </dd>
    </div>
  )
}

export function BootFailureEvidence({ runId, failure }: { runId: string; failure: NonNullable<RunManifest['bootFailure']> }) {
  return (
    <section data-testid="boot-failure-evidence" className={`mt-4 rounded-md border p-3 text-xs ${alertClass('error')}`}>
      <div className="flex items-center justify-between gap-3">
        <SectionHeader>Boot failure evidence</SectionHeader>
        <span className="font-mono">{bootEvidenceLabel(failure)}</span>
      </div>
      <p className="mt-1">{failure.detail}</p>
      <div className="mt-2">
        <BootEvidenceRows failure={failure} />
      </div>
      {failure.excerpt && (
        <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-canvas p-2 font-mono text-secondary">
          {failure.excerpt}{failure.excerptTruncated ? '\n… excerpt truncated; open the full log' : ''}
        </pre>
      )}
      {failure.nextAction && <p className="mt-2 text-secondary">{failure.nextAction}</p>}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <button type="button" className="cl-button min-h-6 shrink-0 px-2 py-0.5" onClick={() => { void openRunLog(runId, failure.logPath) }}>
          Open full service log
        </button>
      </div>
    </section>
  )
}

function ServiceFailureEvidence({ runId, failure }: { runId: string; failure: NonNullable<RunManifest['serviceFailure']> }) {
  return (
    <section data-testid="service-failure-evidence" className={`mt-4 rounded-md border p-3 text-xs ${alertClass('error')}`}>
      <SectionHeader>Service failure after readiness</SectionHeader>
      <p className="mt-1">{failure.service}: {failure.detail}</p>
      <p className="mt-1 text-secondary">Cause: {failure.kind}. Playwright results from this attempt may be partial.</p>
      {failure.excerpt && (
        <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-canvas p-2 font-mono text-secondary">
          {failure.excerpt}{failure.excerptTruncated ? '\n… excerpt truncated; open the full log' : ''}
        </pre>
      )}
      <button type="button" className="cl-button mt-2 min-h-6 px-2 py-0.5" onClick={() => { void openRunLog(runId, failure.logPath) }}>
        Open full service log
      </button>
    </section>
  )
}

export function healAgentOverviewLabel(manifest: RunManifest): string | null {
  if (manifest.healMode === 'external' && manifest.externalHealSession) {
    return clientLabel(manifest.externalHealSession.clientKind, 'External agent session')
  }
  if (manifest.healAgent === 'claude') return 'Claude'
  if (manifest.healAgent === 'codex') return 'Codex'
  if (manifest.healMode === 'manual') return 'Manual'
  if (manifest.healMode === 'external') return 'External agent session'
  if (manifest.healMode === 'auto') return 'Auto'
  return null
}

export function VerifyOverviewTab({
  manifest,
  view,
  onCompareTests,
}: {
  manifest: RunManifest
  view: RunViewModel
  onCompareTests?: () => void
}) {
  const duration = durationBetween(manifest.startedAt, manifest.endedAt)
  const verification = manifest.verification
  const targets = verification?.targets ?? []
  return (
    <RunPane padded>
      <dl className="grid grid-cols-[118px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="cl-rubric self-center">Suite</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={manifest.feature}>{manifest.feature}</dd>
        <dt className="cl-rubric self-center">Configuration</dt>
        <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={verification?.configName ?? 'Unsaved'}>{verification?.configName ?? 'Unsaved'}</dd>
        <dt className="cl-rubric self-center">Playwright envset</dt>
        <dd className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }} title={verification?.playwrightEnvsetId ?? manifest.env ?? ''}>{verification?.playwrightEnvsetId ?? manifest.env ?? '-'}</dd>
        <dt className="cl-rubric self-center">Duration</dt>
        <dd style={{ color: 'var(--text-primary)' }}>{manifest.status === 'queued' ? 'Not started' : duration == null ? 'in progress' : formatDuration(duration)}</dd>
        <dt className="cl-rubric self-center">{manifest.status === 'queued' ? 'Queued at' : 'Started'}</dt>
        <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.startedAt}>{manifest.startedAt}</dd>
        {manifest.endedAt && (
          <>
            <dt className="cl-rubric self-center">Ended</dt>
            <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={manifest.endedAt}>{manifest.endedAt}</dd>
          </>
        )}
      </dl>
      <RecordedTestChanges manifest={manifest} onCompare={onCompareTests} />
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
        <EmptyState {...EMPTY_COPY.lifecycle} icon={EmptyGlyph.timeline} />
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
