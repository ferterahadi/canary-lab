import fs from 'fs'
import path from 'path'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { syncEnvsInConfig } from './envset-config'
import { publishEnvsetChange } from './envset-events'
import { isWithin } from './path-containment'

/** Callers resolve the suite directory, including renamed suites and Flight's
 * pre-scaffold fallback. Missing environments are an HTTP refusal or an
 * idempotent reset, so the caller translates that result. */
export function removeEnvironment(
  deps: { feature: string; featureDir: string; workspaceEvents?: WorkspaceEventPublisher },
  env: string,
): 'removed' | 'missing' | 'invalid' {
  const root = path.resolve(deps.featureDir, 'envsets')
  const target = path.resolve(path.join(root, env))
  if (target === root || !isWithin(root, target)) return 'invalid'
  if (!fs.existsSync(target)) return 'missing'
  fs.rmSync(target, { recursive: true, force: true })
  syncEnvsInConfig(deps.featureDir)
  publishEnvsetChange(deps.workspaceEvents, deps.feature, 'structure')
  return 'removed'
}
