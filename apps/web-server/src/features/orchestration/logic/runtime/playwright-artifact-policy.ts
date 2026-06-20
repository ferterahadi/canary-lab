import fs from 'fs'
import path from 'path'
import { readPlaywrightConfig, type ConfigValue } from '../config-ast'
import type { PlaywrightArtifactPolicy } from './manifest'

const PLAYWRIGHT_CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.cjs']

export const DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY: PlaywrightArtifactPolicy = {
  screenshot: 'only-on-failure',
  video: 'off',
  trace: 'retain-on-failure',
}

const SCREENSHOT_MODES = ['off', 'on', 'only-on-failure'] as const
const RETAINABLE_MODES = ['off', 'on', 'on-first-retry', 'retain-on-failure'] as const

export function readPlaywrightArtifactPolicy(featureDir: string): PlaywrightArtifactPolicy {
  const cfgPath = findPlaywrightConfig(featureDir)
  if (!cfgPath) return DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY
  try {
    return artifactPolicyFromConfig(readPlaywrightConfig(fs.readFileSync(cfgPath, 'utf-8')).value)
  } catch {
    return DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY
  }
}

export function artifactPolicyFromConfig(value: ConfigValue): PlaywrightArtifactPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY
  }
  const use = (value as Record<string, ConfigValue>).use
  if (!use || typeof use !== 'object' || Array.isArray(use)) {
    return DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY
  }
  const useObj = use as Record<string, ConfigValue>
  return {
    screenshot: readMode(useObj.screenshot, SCREENSHOT_MODES, DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY.screenshot),
    video: readMode(useObj.video, RETAINABLE_MODES, DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY.video),
    trace: readMode(useObj.trace, RETAINABLE_MODES, DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY.trace),
  }
}

function readMode<T extends string>(value: ConfigValue | undefined, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
}

function findPlaywrightConfig(featureDir: string): string | null {
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    const candidate = path.join(featureDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}
