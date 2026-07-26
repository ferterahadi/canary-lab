import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { collectPortSlots } from './orchestrator'
import { allocatePorts } from './port-allocator'
import { resolvePortTokens } from './launcher/interpolate'
import { getEnvSetsDir, loadConfig, backup, applySet, resolveVars } from './env-switcher/switch'
import type { BackupRecord } from './env-switcher/types'

// Run primitives shared by every feature that starts a run: the run loop itself,
// verification (coverage), and benchmark. They were inline in server.ts, which
// meant a feature could only reach them by living there too.

// Allocate one free TCP port per declared port slot for this run so concurrent
// runs (even of the same app) never clash on a hardcoded port. Returns
// undefined when the feature declares no port slots — the run then behaves
// exactly as before. The orchestrator releases these ports on stop.
export async function allocateRunPorts(
  feature: FeatureConfig,
  env: string | undefined,
): Promise<Map<string, number> | undefined> {
  const slots = collectPortSlots(feature, env)
  return slots.length > 0 ? await allocatePorts(slots) : undefined
}

// Apply a feature's envset in-process and return the backups to revert later.
// Returns null when the feature has no envsets configured (silent skip).
export function applyFeatureEnvset(
  featureDir: string,
  setName: string,
  portMap?: Map<string, number>,
): BackupRecord[] | null {
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return null
  const config = loadConfig(featureDir)
  const targets = config.feature.slots.map((slot) => ({
    slot,
    targetPath: resolveVars(config.slots[slot].target, config.appRoots),
  }))
  const backups = backup(targets, Date.now())
  // Resolve the reserved ${port.<slot>} namespace in each applied file so a
  // multi-service feature's inter-service config follows the run's allocated
  // ports. No port map (e.g. verify path) → verbatim copy.
  const resolve = portMap && portMap.size > 0
    ? (content: string) => resolvePortTokens(content, portMap)
    : undefined
  applySet(envSetsDir, setName, targets, resolve)
  return backups
}
