import { loadFeatures } from '../../../shared/feature-loader'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { overlayExists } from './runtime/overlay'
import { revertPortification } from './runtime/unportify'

type RemovalResult =
  | { ok: true; value: { name: string; portified: boolean; reverted: boolean } }
  | { ok: false; statusCode: 404; error: 'feature not found' }

/** REST and MCP share mutation ownership; transport adapters only translate
 * results. Flight reset retains its own guard and uses the restoration core. */
export function removeFeaturePortification(
  deps: { featuresDir: string; workspaceEvents?: WorkspaceEventPublisher },
  name: string,
): RemovalResult {
  const feature = loadFeatures(deps.featuresDir).find((entry) => entry.name === name)
  if (!feature?.featureDir) return { ok: false, statusCode: 404, error: 'feature not found' }
  const { reverted } = revertPortification(feature.featureDir)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
  return { ok: true, value: { name: feature.name, portified: overlayExists(feature.featureDir), reverted } }
}
