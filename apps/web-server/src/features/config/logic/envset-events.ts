import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

/** Writers announce after persistence so REST, MCP and Flight callers share
 * the same refresh contract without adapters publishing a second time. */
export function publishEnvsetChange(
  publisher: WorkspaceEventPublisher | undefined,
  feature: string,
  scope: 'slots' | 'structure',
): void {
  publishWorkspaceEvent(publisher, { type: 'envsets-changed', feature })
  if (scope === 'structure') publishWorkspaceEvent(publisher, { type: 'features-changed' })
}
