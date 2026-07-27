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
      className={`cl-tab flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-1 ${active ? 'cl-tab-active' : ''}`}
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      <ServiceStatusDot status={service.status} />
      <span className="max-w-[150px] truncate">{labelParts.primary}</span>
      {labelParts.branch && (
        <span className="max-w-[120px] truncate rounded px-1 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: branch?.dirty ? 'var(--warning)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          @ {labelParts.branch}
        </span>
      )}
    </button>
  )
}

export function ServiceCard({
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

export function BranchRow({ branch }: { branch: RepoBranchSnapshot }) {
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
            style={{ background: 'var(--bg-selected)', color: 'var(--warning)' }}
          >
            dirty
          </span>
        )}
        {mismatch && (
          <span
            className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider"
            style={{ background: 'var(--bg-selected)', color: 'var(--warning)' }}
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

export function ServiceField({ label, value, href }: { label: string; value: string; href?: string }) {
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
