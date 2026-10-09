import type { FlightStageKey } from '@shared/flights/types'
import type { FeatureActivity } from '../../state/feature-activity'
import type { PickerFeature, WorkState } from '@/shared/state/work-state'
import { WorkspaceTestProviders } from '@/test-helpers/workspace-providers'
import { FlightsPill, type FlightsPillProps } from '../FlightsPill'

/** FlightsPill under the two workspace contexts WorkspaceProvider fills. Its data and
 *  destinations used to be props; tests still pass them here under their old
 *  names, and the harness hands each to the context the pill now reads. */
export function FlightsPillHarness({
  flights, preFlights, activity, features, coverageJobs, portifyWorkflows,
  onOpenFlight, onOpenActivity, onStartFlight, onOpenPreFlight, ...props
}: FlightsPillProps & Pick<WorkState, 'flights' | 'preFlights' | 'activity' | 'coverageJobs' | 'portifyWorkflows'> & {
  features?: PickerFeature[]
  onOpenFlight?: (flightId: string | null, stage?: FlightStageKey) => void
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  onStartFlight?: (feature: string) => void
  onOpenPreFlight?: (taskId: string) => void
}) {
  return (
    <WorkspaceTestProviders
      workState={{ flights, preFlights, activity, pickerFeatures: features, coverageJobs, portifyWorkflows }}
      actions={{ openFlight: onOpenFlight, openActivity: onOpenActivity, startFlight: onStartFlight, openPreFlight: onOpenPreFlight }}
    >
      <FlightsPill {...props} />
    </WorkspaceTestProviders>
  )
}
