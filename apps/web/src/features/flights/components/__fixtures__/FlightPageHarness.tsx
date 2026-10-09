import { act, type ComponentProps, type ComponentType } from 'react'
import type { Root } from 'react-dom/client'
import { vi } from 'vitest'
import { InvalidationProvider } from '@/shared/state/invalidation'
import type { WorkState } from '@/shared/state/work-state'
import { WorkspaceTestProviders } from '@/test-helpers/workspace-providers'
import { FlightPage } from '../FlightPage'

/** FlightPage under the WorkState WorkspaceProvider fills. The live work snapshot used to
 *  be FlightPage props; tests still pass it here the same way, and the harness
 *  hands it to the context the flight detail now reads. */
export function FlightPageHarness({ activity, externalHistory, coverageJobs, derivedStages, ...props }:
  ComponentProps<typeof FlightPage> & Pick<WorkState, 'activity' | 'externalHistory' | 'coverageJobs' | 'derivedStages'>) {
  return (
    <WorkspaceTestProviders workState={{ activity, externalHistory, coverageJobs, derivedStages }}>
      <FlightPage {...props} />
    </WorkspaceTestProviders>
  )
}

let renderSeq = 0

/** Renders `Page` (bare FlightPage, or the harness above) as a fresh view of
 *  `flightId`. The key bumps on every call so a second render remounts rather
 *  than re-rendering the previous view; the counter is per suite, because each
 *  test file gets its own copy of this module. */
export async function renderFlightPage(
  root: Root,
  Page: ComponentType<ComponentProps<typeof FlightPage>>,
  flightId: string,
  extraProps: Record<string, unknown> = {},
) {
  renderSeq += 1
  await act(async () => {
    root.render(
      <InvalidationProvider>
        <Page key={renderSeq} flightId={flightId} onSelectFlight={vi.fn()} onClose={vi.fn()} {...extraProps} />
      </InvalidationProvider>,
    )
  })
}
