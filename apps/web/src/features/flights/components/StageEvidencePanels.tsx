import { useState } from 'react'
import type { PortifyBootInstance, PortifyManifest } from '@/shared/api/client'
import type { EvaluationExportTask, RunDetail, ServiceManifestEntry } from '@/shared/api/types'
import { useEvaluationExports } from '@/features/evaluation'
import { PanelCard } from '@/shared/ui/PanelCard'
import { StatusDot } from '@/shared/ui/atoms'
import { evaluationArchiveFilename, formatBytes, formatDuration, timeAgo } from '@/shared/lib/format'
import { STAGE_COLUMN } from './stage-meta'
import { plural } from './StageFacts'
import { CONFIG_GROUP, groupOverlayFiles, overlayDiffStat, serviceReadyMs, splitFilePath } from './stage-metrics'

// The evidence blocks that sit UNDER a stage's band: the per-service boot rows,
// the portify double-boot proof and its overlay, and the Evaluation Report's
// deliverable + every archive ever built for the suite. Each one carries the
// identities behind a band tile's count, so the band stays counts-only and the
// detail stays here (the same split the Test Run stage already uses: metric
// tiles, then the failing tests by name).
//
// All four are PanelCard, like every other block in a stage pane.

/** One boot row: the run's own service entry, or the thinner shape recorded
 *  evidence can supply. `startingAt`/`readyAt` are absent on the latter, which is
 *  what makes the timing column drop out rather than read zero. */
type BootRow = Pick<ServiceManifestEntry, 'name' | 'safeName' | 'allocatedPorts' | 'startingAt' | 'readyAt'> & {
  /** Looser than the run's own `ServiceStatus`: recorded evidence stores whatever
   *  string the boot wrote, and the rows only ever test it for `timeout`. */
  status?: string
}

/** Boot check (Suite setup): which services came up, on which port, and how long
 *  each took. The band above states the total; this names the services, so a
 *  slow or failed one is identifiable rather than hidden inside "2/2". */
export function BootCheckPanel({ boot, recorded = [] }: {
  boot: RunDetail | null
  /** Service names + statuses off the env-capture evidence. Used when the boot
   *  RUN is unavailable (its directory cleaned away), so the stage still names
   *  which services came up — just without ports or timings, which only the run
   *  ever held. */
  recorded?: Array<{ name?: string; status?: string }>
}) {
  const fromRun: BootRow[] = boot?.manifest.services ?? []
  const services: BootRow[] = fromRun.length > 0
    ? fromRun
    : recorded
        .filter((s): s is { name: string; status?: string } => typeof s.name === 'string')
        .map((s) => ({ name: s.name, safeName: s.name, status: s.status }))
  if (services.length === 0) return null
  // Worst-first: a service that never passed its probe is the reason the stage
  // is worth looking at, so it sorts above the healthy ones.
  const rows = [...services].sort((a, b) =>
    Number(b.status === 'timeout') - Number(a.status === 'timeout'))
  return (
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="Boot check" testId="boot-check-panel">
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {rows.map((service) => {
            const failed = service.status === 'timeout'
            const readyMs = serviceReadyMs(service)
            const port = Object.values(service.allocatedPorts ?? {})[0]
            return (
              <li key={service.safeName} className="flex min-w-0 items-center gap-2 py-1.5 text-[12px]">
                <StatusDot state={failed ? 'failed' : 'success'} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{service.name}</span>
                {port != null && (
                  <span className="shrink-0 text-[11px] text-muted" style={{ fontFamily: 'var(--font-mono)' }}>:{port}</span>
                )}
                <span
                  className="shrink-0 text-[11px]"
                  style={{ color: failed ? 'var(--danger)' : 'var(--text-secondary)' }}
                >
                  {failed
                    ? 'never passed its health check'
                    : readyMs != null
                      ? `ready in ${formatDuration(readyMs)}`
                      /* No stamped pair (a boot recorded before the timings
                         existed): say it came up rather than echoing the raw
                         last status. That status is `stopped` on every dry-run
                         boot — env-capture tears the services down in a
                         `finally` once they pass — and "stopped" sitting under
                         "Services booted 2/2" reads as a contradiction when both
                         are describing the same success. */
                      : 'came up'}
                </span>
              </li>
            )
          })}
        </ul>
      </PanelCard>
    </div>
  )
}

/** Double-boot proof (Parallel readiness): the two concurrent instances and the
 *  ports each was handed. This is the whole claim of the stage — that two runs of
 *  the same services can coexist — so the evidence is the port sets. */
export function DoubleBootPanel({ portify }: { portify: PortifyManifest | null }) {
  const instances = portify?.verification?.instances ?? []
  if (instances.length === 0) return null
  return (
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="Double-boot proof" testId="double-boot-panel">
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {instances.map((instance: PortifyBootInstance, i: number) => (
            <li key={i} className="flex min-w-0 items-center gap-2 py-1.5 text-[12px]">
              <StatusDot state={instance.ok ? 'success' : 'failed'} className="shrink-0" />
              <span className="w-[76px] shrink-0">Instance {String.fromCharCode(65 + i)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                {Object.entries(instance.ports).map(([slot, port]) => `${slot} :${port}`).join(' · ')}
              </span>
              {!instance.ok && instance.failedService && (
                <span className="shrink-0 text-[11px] text-danger">{instance.failedService} failed</span>
              )}
            </li>
          ))}
        </ul>
        {portify?.verification?.failureDetail && (
          <p className="mt-2 mb-0 text-[11px] text-danger">{portify.verification.failureDetail}</p>
        )}
      </PanelCard>
    </div>
  )
}

/** Overlay (Parallel readiness): which files the edit touched, grouped by the repo
 *  that owns them and worst-first by size of change within each group.
 *
 *  Grouping is not decoration. Overlay paths are repo-relative, so a two-repo
 *  stack that gained a port-injection line in each `build.gradle` produced two
 *  rows reading `build.gradle +8` with nothing to tell them apart — the reader
 *  could not answer "which app was edited". The repo heading answers it, and the
 *  directory dims so a long source path scans as fast as a bare filename.
 *
 *  The footer states what an overlay IS, because "7 files edited" otherwise reads
 *  as edits landing in the user's product repos. */
export function OverlayPanel({ portify }: { portify: PortifyManifest | null }) {
  const stat = overlayDiffStat(portify?.diff)
  if (!stat) return null
  const groups = groupOverlayFiles(stat.byFile)
  // Only count repos when every group IS one — a feature-config block is not a
  // repo, and an unlabelled group (pre-header capture) has nothing to count.
  const repoGroups = groups.filter((g) => g.group && g.group !== CONFIG_GROUP)
  const kicker = repoGroups.length > 1 && repoGroups.length === groups.length
    ? `Overlay · ${plural(stat.files, 'file')} across ${plural(repoGroups.length, 'repo')}`
    : `Overlay · ${plural(stat.files, 'file')}`
  return (
    <div className={STAGE_COLUMN}>
      <PanelCard kicker={kicker} testId="overlay-panel">
        {groups.map((group) => (
          <div key={group.group ?? '·'} className="mb-1.5 last:mb-0">
            {group.group && (
              <div className="pb-0.5 text-[11px] text-secondary" data-testid={`overlay-group-${group.group}`}>
                {group.group}
              </div>
            )}
            <ul className={`m-0 flex list-none flex-col p-0 ${group.group ? 'pl-3' : ''}`}>
              {group.files.map((file) => {
                const { dir, base } = splitFilePath(file.path)
                return (
                  <li key={file.path} className="flex min-w-0 items-center gap-2 py-0.5 text-[11px]">
                    {/* The directory truncates and the filename never does: cutting
                        the tail would hide the one part of a deep source path that
                        identifies the file. */}
                    <span className="flex min-w-0 flex-1 items-baseline" style={{ fontFamily: 'var(--font-mono)' }} title={file.path}>
                      {dir && <span className="min-w-0 truncate text-muted">{dir}</span>}
                      <span className="shrink-0 text-secondary">{base}</span>
                    </span>
                    {file.added > 0 && <span className="shrink-0" style={{ color: 'var(--success)' }}>+{file.added}</span>}
                    {file.removed > 0 && <span className="shrink-0" style={{ color: 'var(--danger)' }}>−{file.removed}</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        <p className="mt-2 mb-0 text-[11px] text-muted">
          Kept as the feature's overlay — applied into each run's worktree at boot and reversed at teardown.
          Nothing lands in the product repos.
        </p>
      </PanelCard>
    </div>
  )
}

/** This flight's report: the deliverable, named as the user will receive it, with
 *  the one download for it. The band above measures what the report SAYS; this
 *  says what it IS and hands it over. */
export function EvaluationDeliverablePanel({ task }: { task: EvaluationExportTask | null }) {
  if (!task) return null
  const filename = evaluationArchiveFilename(task.feature, task.runId)
  return (
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="This flight's report" testId="evaluation-deliverable">
        <dl className="m-0 grid gap-x-3 gap-y-1 text-[12px]" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <dt className="cl-rubric self-center">From run</dt>
          <dd className="m-0 min-w-0 truncate" style={{ fontFamily: 'var(--font-mono)' }}>{task.runId}</dd>
          <dt className="cl-rubric self-center">Built by</dt>
          <dd className="m-0 min-w-0 truncate text-secondary">{builtBy(task)}</dd>
          {task.archive && (
            <>
              <dt className="cl-rubric self-center">Contains</dt>
              <dd className="m-0 min-w-0 truncate text-secondary">
                {archiveContents(task)}
              </dd>
            </>
          )}
        </dl>
        <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-line-subtle pt-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" style={{ fontFamily: 'var(--font-mono)' }} title={filename}>
            {filename}
          </span>
          <ArchiveDownloadButton task={task} label="Download" />
        </div>
      </PanelCard>
    </div>
  )
}

/** Every export ever built for this suite, newest first — the flight's report is
 *  marked, and each row downloads its own archive. Cleanup never prunes these, so
 *  a report from six days ago is still a live download. */
export function AllReportsPanel({
  feature,
  pinnedTaskId,
}: {
  feature: string
  /** The task THIS flight's stage produced, badged in the list. */
  pinnedTaskId?: string
}) {
  const { tasks } = useEvaluationExports()
  // The provider already holds every task in the workspace, newest-first, and
  // keeps them live over workspace events — so this is a filter, not a fetch.
  const mine = tasks.filter((t) => t.feature === feature)
  if (mine.length === 0) return null
  return (
    <div className={STAGE_COLUMN}>
      <PanelCard kicker="All reports for this suite" aside={<span className="cl-count-chip">{mine.length}</span>} testId="all-reports-panel">
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {mine.map((task) => (
            <li key={task.taskId} data-testid={`report-row-${task.taskId}`} className="flex min-w-0 items-center gap-2 py-1.5">
              <StatusDot state={task.status === 'failed' ? 'failed' : task.status === 'running' ? 'running' : 'success'} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium">Run {task.runId}</span>
                  <span className="cl-count-chip shrink-0">{task.mode === 'localized' ? 'agent-rewritten' : 'from evidence'}</span>
                  {task.taskId === pinnedTaskId && (
                    <span className="shrink-0 text-[10px] text-accent">this flight</span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-muted">
                  {task.status === 'failed'
                    /* A failed export has no archive; saying so beats a dead
                       button, and the reason is the only useful thing left. */
                    ? (task.error ?? 'export failed')
                    : [archiveContents(task), timeAgo(task.updatedAt)].filter(Boolean).join(' · ')}
                </div>
              </div>
              {task.downloadReady
                ? <ArchiveDownloadButton task={task} />
                : <span className="shrink-0 pr-1 text-[10.5px] text-muted">{task.status === 'running' ? 'building…' : 'no archive'}</span>}
            </li>
          ))}
        </ul>
      </PanelCard>
    </div>
  )
}

/** One archive's download. Icon-only in a row, labelled on the deliverable card.
 *  A failure turns the control danger-toned and retries on click rather than
 *  failing silently. */
function ArchiveDownloadButton({ task, label }: { task: EvaluationExportTask; label?: string }) {
  const { downloadTask } = useEvaluationExports()
  const [failed, setFailed] = useState(false)
  const filename = evaluationArchiveFilename(task.feature, task.runId)
  const title = failed ? 'Download failed — click to retry' : `Download ${filename}`
  const download = (): void => {
    setFailed(false)
    downloadTask(task.taskId).catch(() => setFailed(true))
  }
  return (
    <button
      type="button"
      data-testid={`download-report-${task.taskId}`}
      onClick={download}
      aria-label={title}
      title={title}
      className={label ? 'cl-button shrink-0 px-2 py-0.5 text-[11px]' : 'cl-icon-button h-6 w-6 shrink-0 text-[12px]'}
      style={failed ? { color: 'var(--danger)' } : undefined}
    >
      {label ? `⬇ ${label}` : '⬇'}
    </button>
  )
}

function builtBy(task: EvaluationExportTask): string {
  const how = task.mode === 'localized' ? 'agent rewrite' : 'built from run evidence'
  const who = task.producer === 'external' ? 'your own client' : task.sessionRef?.agent
  return who ? `${how} · ${who}` : how
}

/** "11 videos · 4.2 MB", or just the size when the archive holds no videos.
 *  Empty string when the contents were never recorded (an older export), so the
 *  caller's join drops it instead of printing "0 videos". */
function archiveContents(task: EvaluationExportTask): string {
  const archive = task.archive
  if (!archive) return ''
  const videos = archive.videos > 0 ? `${archive.videos} ${archive.videos === 1 ? 'video' : 'videos'}` : null
  return [videos, formatBytes(archive.bytes)].filter(Boolean).join(' · ')
}
