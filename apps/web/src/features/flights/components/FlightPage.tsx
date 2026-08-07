import type { FlightStageKey } from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import type { FeatureActivity } from '../state/feature-activity'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab, RunOpenTarget } from '@/shared/lib/workspace-view-state'
import { type DerivedStage } from '../lib/derived-stages'
import { FlightDetail } from './FlightDetail'

export { configDigestFacts } from './FlightSummaryStrip'

/** Drill-through targets: each stage view is a LENS onto the real underlying
 *  surface — the actual run detail, coverage ledger, ports config — never a
 *  re-implementation of them (R6). Parallel readiness has no entry here: it
 *  drills through `onOpenConfig` to the Ports tab, so FlightPage never opens
 *  the portify wizard itself. */
export interface FlightDrillThroughs {
  /** `target` says where in the run detail to land — a failing test (Playwright)
   *  or a named tab (the run's captured fixes go to Changes). */
  onOpenRun?: (feature: string, runId: string, target?: RunOpenTarget) => void
  onOpenCoverage?: (feature: string) => void
}

export function FlightPage({
  flightId,
  onSelectFlight,
  onClose,
  activity,
  derivedStages,
  onStartFlight,
  onOpenConfig,
  onOpenRun,
  onOpenCoverage,
  stage,
  onSelectStage,
}: {
  /** A real flight id, or a `feature:<name>` derived token (R81). */
  flightId: string
  /** Back to the flights picker (null clears the selected flight). */
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
  /** Per-feature live activity (runs / portify / authoring) — App owns it. */
  activity?: Map<string, FeatureActivity>
  /** R81: evidence-derived rails per feature — App owns the one instance (same
   *  ownership rule as `activity`). Supplies the stages for a derived token. */
  derivedStages?: Map<string, DerivedStage[]>
  /** Opens the flight launcher for this feature — the "Start fresh" handoff
   *  (R75): full restart with editable intent + repos lives THERE, never in
   *  the re-run dialog. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  /** Opens FeatureConfigEditor — the Feature Setup panel's Advanced setup, and
   *  the Parallel-readiness drill-through (which aims at the Ports tab). */
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void
  /** The routed stage selection (`?stage=…`) and its setter — App owns them so
   *  the pick survives a drill-through and a refresh. Pass both or neither. */
  stage?: FlightStageKey | null
  onSelectStage?: (stage: FlightStageKey | null) => void
} & FlightDrillThroughs) {
  // The flight detail refetches on `flights-changed`; the setup digest on
  // `features-changed` (repos); the Requirements docs list on `coverage-changed`.
  const refreshKey = useInvalidationKey('flights')
  const configRefreshKey = useInvalidationKey('repos')
  const docsRefreshKey = useInvalidationKey('coverage')
  return (
    <div className="flex h-full w-full flex-col bg-canvas text-primary">
      <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} onNavigateFlight={onSelectFlight} onStartFlight={onStartFlight} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} activity={activity} derivedStages={derivedStages} drill={{ onOpenRun, onOpenCoverage }} stage={stage} onSelectStage={onSelectStage} />
    </div>
  )
}
