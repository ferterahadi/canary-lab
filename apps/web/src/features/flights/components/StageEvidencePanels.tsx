import { useState } from 'react'
import type { PortifyBootInstance, PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, EvaluationExportTask, RunDetail, ServiceManifestEntry, TestCoverage, TestStrength } from '@/shared/api/types'
import { useEvaluationExports } from '@/features/evaluation'
import { GAP_META, SEG_ORDER, STRENGTH_META, STRENGTH_ORDER, countFor } from '@/features/coverage'
import { PanelCard } from '@/shared/ui/PanelCard'
import { SkeletonBar, SkeletonBead, SkeletonPanel, type AwaitingState } from '@/shared/ui/Skeleton'
import { StatusDot } from '@/shared/ui/atoms'
import { evaluationArchiveFilename, formatBytes, formatDuration, timeAgo } from '@/shared/lib/format'
import { StageColumn } from './stage-meta'
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

/** The row geometry both states share. The settled row's height comes from its
 *  12px text line box (measured: 30px with the padding); a placeholder row has no
 *  text node to set one, so it would collapse to its bar's 7px and the card would
 *  grow under the reader when the services land. The floor is on the SHARED class
 *  so the two can't drift: it is what the settled row already measures, which is
 *  why adding it changes nothing for that row. */
const BOOT_ROW = 'flex min-h-[30px] min-w-0 items-center gap-2 py-1.5 text-[12px]'

/** Boot check (Suite setup): which services came up, on which port, and how long
 *  each took. The band above states the total; this names the services, so a
 *  slow or failed one is identifiable rather than hidden inside "2/2".
 *
 *  The awaited card renders the same rows with bars where the name, port and
 *  timing go. Unlike the portify instances, the service COUNT is genuinely
 *  unknown until the boot run is read — nothing in the flight record holds it —
 *  so two rows is an honest guess at the shape rather than a prediction, and only
 *  the per-row geometry is pinned. */
export function BootCheckPanel({ boot, recorded = [], awaiting }: {
  /** R83: the stage hasn't settled and there is no boot yet — hold the card's
   *  place with its skeleton instead of vanishing. A settled stage passes
   *  nothing, so a suite that genuinely booted no services still renders no
   *  card rather than an empty promise. */
  awaiting?: AwaitingState
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
  // Worst-first: a service that never passed its probe is the reason the stage
  // is worth looking at, so it sorts above the healthy ones.
  const known: BootRow[] | null = services.length > 0
    ? [...services].sort((a, b) => Number(b.status === 'timeout') - Number(a.status === 'timeout'))
    : null
  if (!known && !awaiting) return null
  return (
    <StageColumn>
      <PanelCard kicker="Boot check" testId={known ? 'boot-check-panel' : 'boot-check-skeleton'}>
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {(known ?? [null, null]).map((service, i) => {
            if (!service) {
              return (
                <li key={i} className={BOOT_ROW}>
                  {awaiting && (
                    <>
                      {/* 0.55rem is `.cl-status-dot`'s own size — the bead has the
                          knob for exactly this, so both sit on one axis. */}
                      <SkeletonBead awaiting={awaiting} size={8.8} />
                      <span className="min-w-0 flex-1"><SkeletonBar awaiting={awaiting} width="46%" height={7} /></span>
                      <SkeletonBar awaiting={awaiting} width="58px" height={7} className="shrink-0" />
                    </>
                  )}
                </li>
              )
            }
            const failed = service.status === 'timeout'
            const readyMs = serviceReadyMs(service)
            const port = Object.values(service.allocatedPorts ?? {})[0]
            return (
              <li key={service.safeName} className={BOOT_ROW}>
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
                    ? 'never answered'
                    : readyMs != null
                      ? `ready in ${formatDuration(readyMs)}`
                      /* No stamped pair (a boot recorded before the timings
                         existed): say it came up rather than echoing the raw
                         last status. That status is `stopped` on every dry-run
                         boot — env-capture tears the services down in a
                         `finally` once they pass — and "stopped" sitting under
                         "Services booted 2/2" reads as a contradiction when both
                         are describing the same success. */
                      : 'started'}
                </span>
              </li>
            )
          })}
        </ul>
      </PanelCard>
    </StageColumn>
  )
}

/** Double-boot proof (Parallel readiness): the two concurrent instances and the
 *  ports each was handed. This is the whole claim of the stage — that two runs of
 *  the same services can coexist — so the evidence is the port sets.
 *
 *  The awaited card is the same two rows with a bar where the ports go, not a
 *  generic row-list: the COUNT and the NAMES are known before the proof is (the
 *  stage always boots exactly two, A and B), and it is the real `Instance A` text
 *  node that gives the row its height. Sizing a stand-in row to match instead
 *  meant tuning bar heights through three shared components, and it was 7px out
 *  one way and 13px the other — enough to move the Port changes card below it. */
export function DoubleBootPanel({ portify, awaiting }: { portify: PortifyManifest | null; awaiting?: AwaitingState }) {
  const instances = portify?.verification?.instances ?? []
  const proven: PortifyBootInstance[] | null = instances.length > 0 ? instances : null
  if (!proven && !awaiting) return null
  const rows = proven ?? [null, null]
  return (
    <StageColumn>
      <PanelCard kicker="Side-by-side proof" testId={proven ? 'double-boot-panel' : 'double-boot-skeleton'}>
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {rows.map((instance, i) => (
            <li key={i} className="flex min-w-0 items-center gap-2 py-1.5 text-[12px]">
              {instance
                ? <StatusDot state={instance.ok ? 'success' : 'failed'} className="shrink-0" />
                /* 0.55rem is `.cl-status-dot`'s own size — the bead has the knob
                   for exactly this, so the two indicators sit on one axis. */
                : awaiting && <SkeletonBead awaiting={awaiting} size={8.8} />}
              <span className="w-[76px] shrink-0">Instance {String.fromCharCode(65 + i)}</span>
              {instance
                ? (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                    {Object.entries(instance.ports).map(([slot, port]) => `${slot} :${port}`).join(' · ')}
                  </span>
                )
                : awaiting && (
                  <span className="min-w-0 flex-1">
                    <SkeletonBar awaiting={awaiting} width="58%" height={7} />
                  </span>
                )}
              {instance && !instance.ok && instance.failedService && (
                <span className="shrink-0 text-[11px] text-danger">{instance.failedService} failed</span>
              )}
            </li>
          ))}
        </ul>
        {portify?.verification?.failureDetail && (
          <p className="mt-2 mb-0 text-[11px] text-danger">{portify.verification.failureDetail}</p>
        )}
      </PanelCard>
    </StageColumn>
  )
}

/** Overlay (Parallel readiness): which files the edit touched, grouped by the repo
 *  that owns them and worst-first by size of change within each group.
 *
 *  Grouping is not decoration. Overlay paths are repo-relative, so a two-repo
 *  stack that gained a port-injection line in each `build.gradle` produced two
 *  rows reading `build.gradle +8` with nothing to tell them apart — the reader
 *  could not answer "which app was edited". The repo heading answers it, and each
 *  row shows the filename alone so a deep source path scans as fast as a bare one.
 *
 *  The footer states what an overlay IS, because "7 files edited" otherwise reads
 *  as edits landing in the user's product repos. */
export function OverlayPanel({ portify, awaiting }: { portify: PortifyManifest | null; awaiting?: AwaitingState }) {
  const stat = overlayDiffStat(portify?.diff)
  if (!stat) {
    return awaiting ? <StageColumn><SkeletonPanel kicker="Port changes" awaiting={awaiting} testId="overlay-skeleton" variant="rows" rows={3} /></StageColumn> : null
  }
  const groups = groupOverlayFiles(stat.byFile)
  // Only count repos when every group IS one — a feature-config block is not a
  // repo, and an unlabelled group (pre-header capture) has nothing to count.
  const repoGroups = groups.filter((g) => g.group && g.group !== CONFIG_GROUP)
  const kicker = repoGroups.length > 1 && repoGroups.length === groups.length
    ? `Port changes · ${plural(stat.files, 'file')} across ${plural(repoGroups.length, 'repo')}`
    : `Port changes · ${plural(stat.files, 'file')}`
  return (
    <StageColumn>
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
                    {/* Filename only — a deep source path spent the row's whole width
                        on directories nobody reads, and the part that identifies the
                        file sat at the far end. The full path stays one hover away, so
                        the row needs to LOOK hoverable: the `…/` says a directory was
                        elided and the dotted underline says there is more to see. Both
                        drop out for a root-level file, which has nothing to reveal. */}
                    <span
                      className={`flex min-w-0 flex-1 items-baseline ${dir ? 'cursor-help' : ''}`}
                      style={{ fontFamily: 'var(--font-mono)' }}
                      title={file.path}
                    >
                      {dir && <span className="shrink-0 text-muted" data-testid="overlay-path-elision">…/</span>}
                      <span
                        className={`min-w-0 truncate text-secondary ${dir ? 'underline decoration-line-strong decoration-dotted underline-offset-2' : ''}`}
                      >
                        {base}
                      </span>
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
          Saved as a patch. It goes on when a run starts and comes off when it ends —
          nothing lands in the product repos.
        </p>
      </PanelCard>
    </StageColumn>
  )
}

/** Test authoring & coverage: the two distributions behind the band's three
 *  counts — which depth the specs reached, and which kind of gap the uncovered
 *  requirements are.
 *
 *  These lived as segment bars + sub-lines on the tiles themselves, which forced
 *  a five-bucket distribution through one 10.5px line and merged the two amber
 *  gap kinds into a single bar segment. A card has the room to name every bucket
 *  with its own count and hue.
 *
 *  Every label, colour, tooltip and order comes from the coverage feature's own
 *  vocabulary (`GAP_META` / `STRENGTH_META` and their canonical orders), because
 *  the stage header links straight to the ledger page that renders the same two
 *  breakdowns as filters. A private copy here would drift on the first rename.
 *
 *  Zero buckets RENDER, dimmed, rather than dropping out: on a suite that is 7
 *  shallow and nothing else, "0 strong" is the finding. A distribution that hides
 *  its empty classes reads as a shorter distribution, not an emptier one.
 *
 *  The same rule governs a whole GROUP: the depth column renders on a suite with
 *  no mapped tests, all four buckets at zero, rather than dropping out. Dropping
 *  it contradicted the rule one level up — and it moved the card, because the two
 *  groups sit in an `auto-fit` grid: the requirement column stretched to the full
 *  width alone and halved the moment the first mapping pass landed a test.
 *
 *  The awaited card is the SAME render, one prop different: the counts are the
 *  only thing missing, so they are the only thing replaced by a bar. Every bucket
 *  name is static vocabulary rather than a measurement, so naming them early
 *  claims nothing — and it is what makes the placeholder the exact height of the
 *  card it becomes. A generic three-line `SkeletonPanel` here was 74px short, so
 *  the Passes card below still jumped when the ledger landed, which is the shift
 *  the placeholder existed to prevent. */
export function CoverageCompositionPanel({ ledger, awaiting }: { ledger: CoverageLedger | null; awaiting?: AwaitingState }) {
  // A ledger with no requirements composes nothing — for the panel that is the
  // same state as no ledger at all.
  const composed = ledger && ledger.totals.total > 0 ? ledger : null
  if (!composed && !awaiting) return null
  const tests = composed?.tests ?? []
  const strengthOf = (t: TestCoverage): TestStrength => t.strength ?? 'shallow'
  return (
    <StageColumn>
      <PanelCard kicker="Composition" testId={composed ? 'coverage-composition' : 'coverage-composition-skeleton'}>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <CompositionGroup
            testId="composition-strength"
            awaiting={composed ? undefined : awaiting}
            // "Depth", not "strength": the heading has to say what the buckets
            // measure, and depth is what a tier ramp is. Its count is dropped
            // while awaited — the population is exactly what isn't known yet.
            heading={composed ? `Test depth · ${plural(tests.length, 'test')}` : 'Test depth'}
            rows={STRENGTH_ORDER.map((s) => ({
              key: s,
              label: STRENGTH_META[s].label,
              title: STRENGTH_META[s].title,
              color: STRENGTH_META[s].color,
              count: composed ? tests.filter((t) => strengthOf(t) === s).length : null,
            }))}
          />

          <CompositionGroup
            testId="composition-gaps"
            awaiting={composed ? undefined : awaiting}
            heading={composed ? `Requirement coverage · ${plural(composed.totals.total, 'requirement')}` : 'Requirement coverage'}
            rows={SEG_ORDER.map((g) => ({
              key: g,
              label: GAP_META[g].label,
              color: GAP_META[g].color,
              count: composed ? countFor(composed, g) : null,
            }))}
          />
        </div>
        {composed && composed.totals.orphanTests > 0 && (
          <p className="mt-2.5 mb-0 text-[11px] text-muted" data-testid="composition-orphans">
            {plural(composed.totals.orphanTests, 'test')} match no requirement — either a missing label,
            or a test for something nobody asked for.
          </p>
        )}
      </PanelCard>
    </StageColumn>
  )
}

interface CompositionRow {
  key: string
  label: string
  title?: string
  color: string
  /** `null` = not measured yet; the row holds its place with a placeholder where
   *  the figure goes. Distinct from `0`, which is a measurement. */
  count: number | null
}

/** One distribution: a proportional bar, then a row per bucket. The bar drops its
 *  empty segments (a zero-width sliver is noise); the rows keep theirs, dimmed. */
function CompositionGroup({ heading, rows, testId, awaiting }: {
  heading: string
  rows: CompositionRow[]
  testId: string
  awaiting?: AwaitingState
}) {
  const total = rows.reduce((sum, r) => sum + (r.count ?? 0), 0)
  return (
    <div data-testid={testId}>
      <div className="cl-rubric pb-1.5">{heading}</div>
      <div className="mb-2 flex h-[3px] gap-[2px]" aria-hidden>
        {total === 0
          ? <span className="flex-1 rounded-full" style={{ background: 'var(--border-strong)' }} />
          : rows
              .filter((r) => r.count != null && r.count > 0)
              .map((r) => (
                <span key={r.key} className="rounded-full" style={{ width: `${((r.count ?? 0) / total) * 100}%`, background: r.color }} />
              ))}
      </div>
      <dl className="m-0 grid gap-x-2 gap-y-1 text-[11.5px]" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
        {rows.map((r) => {
          // An unmeasured bucket reads like an empty one — quiet dot, quiet
          // label — because that is what it is until the figure arrives.
          const quiet = r.count == null || r.count === 0
          return (
            <div key={r.key} className="col-span-3 grid grid-cols-subgrid items-baseline" data-testid={`${testId}-${r.key}`}>
              <span
                className="h-[7px] w-[7px] translate-y-[-1px] rounded-full"
                style={{ background: r.color, opacity: quiet ? 0.3 : 1 }}
                aria-hidden
              />
              <dt className={quiet ? 'text-muted' : 'text-secondary'} {...(r.title ? { title: r.title } : {})}>{r.label}</dt>
              <dd className={`m-0 tabular-nums ${quiet ? 'text-muted' : ''}`}>
                {r.count == null && awaiting
                  ? <SkeletonBar awaiting={awaiting} width="14px" height={7} className="translate-y-[-2px]" />
                  : r.count}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** This flight's report: the deliverable, named as the user will receive it, with
 *  the one download for it. The band above measures what the report SAYS; this
 *  says what it IS and hands it over. */
export function EvaluationDeliverablePanel({ task, awaiting }: { task: EvaluationExportTask | null; awaiting?: AwaitingState }) {
  if (!task) {
    return awaiting ? <StageColumn><SkeletonPanel kicker="This flight's report" awaiting={awaiting} testId="evaluation-deliverable-skeleton" rows={2} /></StageColumn> : null
  }
  const filename = evaluationArchiveFilename(task.feature, task.runId)
  return (
    <StageColumn>
      <PanelCard kicker="This flight's report" testId="evaluation-deliverable">
        <dl className="m-0 grid gap-x-3 gap-y-1 text-[12px]" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <dt className="cl-rubric self-center">From run</dt>
          <dd className="m-0 min-w-0 truncate" style={{ fontFamily: 'var(--font-mono)' }}>{task.runId}</dd>
          <dt className="cl-rubric self-center">Built by</dt>
          <dd className="m-0 min-w-0 truncate text-secondary">{builtBy(task)}</dd>
          {task.archive && (
            <>
              {/* "Size", not "Contains": this row states the download's weight, so
                  it names the one thing every archive knows. The video count is
                  its own row rather than a "· 11 videos" tail, which would have
                  put a count under a label that says size. */}
              <dt className="cl-rubric self-center">Size</dt>
              <dd className="m-0 min-w-0 truncate text-secondary">{formatBytes(task.archive.bytes)}</dd>
              {task.archive.videos > 0 && (
                <>
                  <dt className="cl-rubric self-center">Videos</dt>
                  <dd className="m-0 min-w-0 truncate text-secondary">{plural(task.archive.videos, 'video')}</dd>
                </>
              )}
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
    </StageColumn>
  )
}

/** Every export ever built for this suite, newest first — the flight's report is
 *  marked, and each row downloads its own archive. Cleanup never prunes these, so
 *  a report from six days ago is still a live download. */
export function AllReportsPanel({
  feature,
  pinnedTaskId,
  awaiting,
}: {
  feature: string
  /** The task THIS flight's stage produced, badged in the list. */
  pinnedTaskId?: string
  awaiting?: AwaitingState
}) {
  const { tasks } = useEvaluationExports()
  // The provider already holds every task in the workspace, newest-first, and
  // keeps them live over workspace events — so this is a filter, not a fetch.
  const mine = tasks.filter((t) => t.feature === feature)
  if (mine.length === 0) {
    // Safe to promise: this stage's own export becomes the first row, so the
    // card is never a placeholder for something that will not arrive.
    return awaiting ? <StageColumn><SkeletonPanel kicker="All reports for this suite" awaiting={awaiting} testId="all-reports-skeleton" variant="rows" rows={2} /></StageColumn> : null
  }
  return (
    <StageColumn>
      <PanelCard kicker="All reports for this suite" aside={<span className="cl-count-chip">{mine.length}</span>} testId="all-reports-panel">
        <ul className="m-0 flex list-none flex-col divide-y divide-line-subtle p-0">
          {mine.map((task) => (
            <li key={task.taskId} data-testid={`report-row-${task.taskId}`} className="flex min-w-0 items-center gap-2 py-1.5">
              <StatusDot state={task.status === 'failed' ? 'failed' : task.status === 'running' ? 'running' : 'success'} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium">Run {task.runId}</span>
                  {/* The flight's own row is marked, not decorated: the status dot
                      is this row's only colour, so the marker stays a quiet label. */}
                  {task.taskId === pinnedTaskId && (
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted">this flight</span>
                  )}
                </div>
                {/* How the report was built is metadata, not a badge — it reads on
                    the same muted line as size and age. */}
                <div className="mt-0.5 truncate text-[10.5px] text-muted">
                  {task.status === 'failed'
                    /* A failed export has no archive; saying so beats a dead
                       button, and the reason is the only useful thing left. */
                    ? (task.error ?? 'export failed')
                    : [task.mode === 'localized' ? 'agent-written' : 'from the run', archiveContents(task), timeAgo(task.updatedAt)]
                        .filter(Boolean)
                        .join(' · ')}
                </div>
              </div>
              {task.downloadReady
                ? <ArchiveDownloadButton task={task} />
                : <span className="shrink-0 pr-1 text-[10.5px] text-muted">{task.status === 'running' ? 'building…' : 'no archive'}</span>}
            </li>
          ))}
        </ul>
      </PanelCard>
    </StageColumn>
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
  const how = task.mode === 'localized' ? 'an agent wrote it' : 'built from the run'
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
