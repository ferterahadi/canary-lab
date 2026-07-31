import type { RepoBranchSnapshot, ServiceManifestEntry, ServiceStatus } from '@/shared/api/types'
import { branchTooltip } from '../utils/run-detail-playback'
import { servicePrimaryLabel, serviceTabLabelParts } from './RunOverviewTabs'

export const STATUS_COLOR: Record<ServiceStatus, string> = {
  queued: 'var(--text-muted)',
  ready: 'var(--success)',
  starting: 'var(--warning)',
  timeout: 'var(--danger)',
  stopped: 'var(--text-muted)',
}

export function ServiceTabButton({
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
      // Same face and geometry as the run's primary tabs (`TabButton`) — a
      // sub-tab is still a tab, and the old chip-sized variant read as a filter.
      className={`cl-tab flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap ${active ? 'cl-tab-active' : ''}`}
    >
      {/* The label comes first so every sub-tab strip starts its text on the
          same left edge. The status dot used to lead, and since it reserves its
          slot even when a stopped service paints it transparent, it indented
          Services' tabs relative to Playwright's by an invisible 6px. */}
      <span className="max-w-[150px] truncate">{labelParts.primary}</span>
      <ServiceStatusDot status={service.status} />
      {labelParts.branch && (
        <span className="max-w-[120px] truncate rounded px-1 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: branch?.dirty ? 'var(--warning)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          @ {labelParts.branch}
        </span>
      )}
    </button>
  )
}

/**
 * One service in the run's Overview — a label/value ledger, the shape this card
 * has always had.
 *
 * Five facts, always all five, always in this order: the name, the command that
 * started it, the directory it started in, the git ref that directory was on,
 * and the URL it answers on. A row whose value is unknown renders as `—` rather
 * than vanishing, so every card in the list has the same shape and a missing
 * branch reads as "no git info here" instead of looking like a different kind
 * of card.
 *
 * Not here: the log path. It was the longest string on the card and the least
 * actionable one — the Services tab streams that same log live.
 *
 * `cwd` is the service's own working directory (a per-run worktree when the run
 * isolates one), never a log location.
 */
export function ServiceCard({
  service,
  branch,
}: {
  service: ServiceManifestEntry
  branch: RepoBranchSnapshot | null
}) {
  const primaryLabel = servicePrimaryLabel(service, branch?.name)
  return (
    <li className="cl-card group/card p-3">
      {/* The title starts on the card's own left edge — flush with the label
          column below it. It carried a status-dot slot before, which indented
          the one line that should anchor the card. State is the chip's job. */}
      <div className="flex min-w-0 items-center gap-2">
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
      <div className="mt-2.5 grid grid-cols-[34px_minmax(0,1fr)_20px] items-center gap-x-2.5 gap-y-1.5">
        <ServiceField label="cmd" value={service.command} tone="primary" />
        <ServiceField label="cwd" value={service.cwd} />
        <BranchRow branch={branch} />
        <ServiceField label="url" value={service.healthUrl ?? ''} href={service.healthUrl ?? undefined} />
      </div>
    </li>
  )
}

export function BranchRow({ branch }: { branch: RepoBranchSnapshot | null }) {
  if (!branch) return <ServiceField label="ref" value="" />
  const value = branch.detached ? 'detached HEAD' : branch.branch ?? 'unknown'
  const mismatch = Boolean(branch.expectedBranch && branch.branch !== branch.expectedBranch)
  return (
    <>
      <FieldLabel>ref</FieldLabel>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
          title={value}
        >
          {value}
        </span>
        {branch.dirty && <FlagChip title="uncommitted changes in this repo">dirty</FlagChip>}
        {mismatch && <FlagChip title={`expected ${branch.expectedBranch}`}>≠ {branch.expectedBranch}</FlagChip>}
      </span>
      <CopyIconButton label="branch" value={value} />
    </>
  )
}

/** Amber marker for a ref that isn't what the run expected. Same hue as every
 *  other "stale / not quite right" signal in the app. */
function FlagChip({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span
      className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider"
      style={{ background: 'var(--bg-selected)', color: 'var(--warning)' }}
      title={title}
    >
      {children}
    </span>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="cl-rubric self-center">{children}</span>
}

export function ServiceField({
  label,
  value,
  href,
  tone = 'secondary',
}: {
  label: string
  /** Empty renders the `—` placeholder — the row holds its slot either way. */
  value: string
  href?: string
  /** `primary` for the command — it is what the service *is*. */
  tone?: 'primary' | 'secondary'
}) {
  if (!value) {
    return (
      <>
        <FieldLabel>{label}</FieldLabel>
        <span className="text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', opacity: 0.6 }} title={`No ${label} recorded for this service`}>—</span>
        <span />
      </>
    )
  }
  return (
    <>
      <FieldLabel>{label}</FieldLabel>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate text-[11px] hover:underline"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}
          title={value}
        >
          {value}
        </a>
      ) : (
        <span
          className="min-w-0 truncate text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: tone === 'primary' ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          title={value}
        >
          {value}
        </span>
      )}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${label}`}
          title={`Open ${label}`}
          className="cl-icon-button h-5 w-5 shrink-0 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 focus-visible:opacity-100"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 3h7v7" />
            <path d="M10 14L21 3" />
            <path d="M21 14v7H3V3h7" />
          </svg>
        </a>
      ) : (
        <CopyIconButton label={label} value={value} />
      )}
    </>
  )
}

/** Copy affordance that stays out of the way until the card is hovered or the
 *  button is tab-focused — these paths and commands are read far more often
 *  than they are copied. */
export function CopyIconButton({ label, value }: { label: string; value: string }) {
  const onCopy = () => {
    void navigator.clipboard?.writeText(value)
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="cl-icon-button h-5 w-5 shrink-0 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 focus-visible:opacity-100"
      style={{ color: 'var(--text-muted)' }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  )
}

export function ServiceStatusDot({ status }: { status?: ServiceStatus }) {
  // Fixed 6×6 slot reserved regardless of status, so the chip text never
  // shifts when the dot appears/disappears (e.g. on `stopped`).
  const color =
    status === 'ready' ? 'var(--success)'      // green
    : status === 'starting' ? 'var(--warning)' // yellow (pulses)
    : status === 'timeout' ? 'var(--danger)'  // red
    : status === 'queued' ? 'var(--text-muted)' // grey (waiting in queue)
    : 'transparent'                     // stopped or undefined
  return (
    <span
      aria-label={status ? `service ${status}` : undefined}
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0${status === 'starting' ? ' canary-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

export function TabButton(props: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, disabled, onClick, children } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`cl-tab shrink-0 whitespace-nowrap ${active ? 'cl-tab-active' : ''}`}
      style={{
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}
