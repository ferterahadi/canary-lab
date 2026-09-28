import fs from 'fs'
import path from 'path'
import { getFeaturesDir, getProjectRoot } from '../../../../../../shared/runtime/project-root'
import type { EnvsetsConfigJson } from './envset-config'

export type SlotDefinition = {
  description: string
  target: string
}

export type FeatureDefinition = {
  slots: string[]
  testCommand: string
  testCwd: string
}

export type EnvSetsConfig = {
  appRoots: Record<string, string>
  slots: Record<string, SlotDefinition>
  feature: FeatureDefinition
}

export function buildAppRoots(cfg: EnvsetsConfigJson): Record<string, string> {
  const root = getProjectRoot()
  return { CANARY_LAB_PROJECT_ROOT: root, CANARY_LAB: root, ...cfg.appRoots }
}

export function resolveVars(str: string, appRoots: Record<string, string>): string {
  return str.replace(/\$([A-Z_]+)/g, (_, key) => appRoots[key] ?? `$${key}`)
}

export function getEnvSetsDir(featureName: string): string {
  return path.join(path.isAbsolute(featureName) ? featureName : path.join(getFeaturesDir(), featureName), 'envsets')
}

// Runtime loading remains strict about presence, but does not adopt authoring's
// metadata validation or HTTP errors.
export function loadConfig(featureName: string): EnvSetsConfig {
  const configPath = path.join(getEnvSetsDir(featureName), 'envsets.config.json')
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing envsets config for "${featureName}" at ${configPath}`)
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as EnvSetsConfig
  config.appRoots = buildAppRoots(config)
  return config
}

export function* selectedEnvsetSources(envSetsDir: string, setName: string, slots: string[]): Generator<{ slot: string; sourcePath: string }> {
  const setDir = path.join(envSetsDir, setName)
  for (const slot of slots) {
    const sourcePath = path.join(setDir, slot)
    if (fs.existsSync(sourcePath)) yield { slot, sourcePath }
  }
}

export function getSlotFilesInSet(envSetsDir: string, setName: string, slots: string[]): string[] {
  return Array.from(selectedEnvsetSources(envSetsDir, setName, slots), ({ slot }) => slot)
}

// Hydration writes one slot at a time; resolving a later invalid target early
// would change which writes survive its existing failure boundary.
export function* selectedEnvsetTargets(envSetsDir: string, setName: string, config: EnvSetsConfig): Generator<{ slot: string; sourcePath: string; targetPath: string }> {
  for (const source of selectedEnvsetSources(envSetsDir, setName, config.feature.slots)) {
    yield { ...source, targetPath: resolveVars(config.slots[source.slot].target, config.appRoots) }
  }
}

export function resolveSetTargets(featureDir: string, setName: string): Array<{ slot: string; targetPath: string }> {
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return []
  return Array.from(selectedEnvsetTargets(envSetsDir, setName, loadConfig(featureDir)), ({ slot, targetPath }) => ({ slot, targetPath }))
}
