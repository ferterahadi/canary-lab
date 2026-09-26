import fs from 'fs'
import path from 'path'
import { getEnvSetsDir, loadConfig } from '../../runs/logic/runtime/env-switcher/switch'
import type { EnvSetsConfig } from '../../runs/logic/runtime/env-switcher/types'
import { parseDotenv } from './dotenv-edit'

export function envsetProcessEnv(
  featureDir: string,
  envName: string | undefined,
  warn: (err: unknown) => void,
): NodeJS.ProcessEnv {
  if (!envName) return {}
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return {}

  let config: EnvSetsConfig
  try {
    config = loadConfig(featureDir)
    if (!isEnvSetsConfig(config)) {
      warn(new Error('envsets.config.json is missing required feature.slots or slots fields'))
      return {}
    }
  } catch (err) {
    warn(err)
    return {}
  }

  const env: NodeJS.ProcessEnv = {}
  for (const slot of config.feature.slots) {
    const sourcePath = path.join(envSetsDir, envName, slot)
    if (!fs.existsSync(sourcePath)) continue
    try {
      const parsed = parseDotenv(fs.readFileSync(sourcePath, 'utf-8'))
      for (const entry of parsed.entries) {
        env[entry.key] = entry.value
      }
    } catch { /* ignore unreadable envset slots */ }
  }
  return env
}

// `config` is the parsed envsets.config.json (loadConfig returns a typed but
// unvalidated object); this checks the runtime shape we actually depend on.
function isEnvSetsConfig(config: EnvSetsConfig): boolean {
  const value = config as Partial<EnvSetsConfig>
  return Boolean(value.feature)
    && typeof value.feature === 'object'
    && Array.isArray(value.feature.slots)
    && value.feature.slots.every((slot) => typeof slot === 'string')
    && Boolean(value.slots)
    && typeof value.slots === 'object'
    && !Array.isArray(value.slots)
}
