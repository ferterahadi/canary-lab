import type { CoverageRecalculation } from '@/shared/state/use-coverage-recalculation'
import type { FlightIndexEntry, FlightManifest, FlightStageKey } from '@shared/flights/types'
import { FlightActionsProvider, type FlightActions } from '../state/flight-actions'
import { FlightDetail } from './FlightDetail'

export function FlightPage({
  flightId,
  recalculation,
  onRetryRecalculation,
  liveFlight,
  missing,
  onFlightMissing,
  indexEntry,
  onSelectFlight,
  onClose,
  onStartFlight,
  onOpenConfig,
  onOpenSpecReview,
  onOpenRun,
  onOpenCoverage,
  stage,
  onSelectStage,
  log,
  onOpenLog,
}: {
  /** A real flight id, or a `feature:<name>` derived token (R81). */
  flightId: string
  recalculation?: CoverageRecalculation | null
  onRetryRecalculation?: () => void
  /** Back to the flights picker (null clears the selected flight). */
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
  /** The manifest the flights channel pushed for this flight, if any. Present
   *  for an ACTIVE flight (the server snapshots those and pushes every write),
   *  absent for a settled one — which reads its record once and never changes. */
  liveFlight?: FlightManifest | null
  missing?: boolean
  onFlightMissing?: (id: string) => void
  /** The flight's `/ws/flights` index row — seeds the header/strip/rail on a
   *  cold open of a settled flight, before its one-time REST read resolves. */
  indexEntry?: FlightIndexEntry | null
  /** The routed stage selection (`?stage=…`) and its setter — App owns them so
   *  the pick survives a drill-through and a refresh. Pass both or neither. */
  stage?: FlightStageKey | null
  onSelectStage?: (stage: FlightStageKey | null) => void
  /** The routed Activity log entry (`?log=…`) and its setter. Pass both or neither. */
  log?: string | null
  onOpenLog?: (id: string | null) => void
} & FlightActions) {
  // The live work snapshot (activity, provenance, coverage jobs, derived rails)
  // reaches the detail through WorkState; this page scopes the drill-through
  // actions to the open flight for every stage below it.
  return (
    <FlightActionsProvider onOpenRun={onOpenRun} onOpenCoverage={onOpenCoverage} onOpenConfig={onOpenConfig} onOpenSpecReview={onOpenSpecReview} onStartFlight={onStartFlight}>
    <div className="flex h-full w-full flex-col bg-canvas text-primary">
      {recalculation && recalculation.status !== 'started' && (
        <div role={recalculation.status === 'failed' ? 'alert' : 'status'} className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs">
          <span>{recalculation.status === 'failed' ? recalculation.error : 'Starting coverage recalculation…'}</span>
          {recalculation.status === 'failed' && <button type="button" className="cl-button" onClick={onRetryRecalculation}>Retry recalculation</button>}
        </div>
      )}
      <FlightDetail activityRequest={recalculation?.request} flightId={flightId} liveFlight={liveFlight} missing={missing} onFlightMissing={onFlightMissing} indexEntry={indexEntry} onClose={onClose} onBackToList={() => onSelectFlight(null)} onNavigateFlight={onSelectFlight} stage={stage} onSelectStage={onSelectStage} log={log} onOpenLog={onOpenLog} />
    </div>
    </FlightActionsProvider>
  )
}
