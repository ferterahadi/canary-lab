import fs from 'fs'
import { readPlaywrightConfig, type ConfigValue } from '../../../../shared/config-ast'
import { findPlaywrightConfig } from '../../../../shared/playwright-config'
import {
  PLAYWRIGHT_RETAINED_ARTIFACT_MODES,
  PLAYWRIGHT_SCREENSHOT_MODES,
} from '../../../../../../../shared/configs/playwright-modes'
import type { PlaywrightArtifactPolicy } from './manifest'

export const DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY: PlaywrightArtifactPolicy = {
  screenshot: 'only-on-failure',
  video: 'off',
  trace: 'retain-on-failure',
}

const SCREENSHOT_MODES = PLAYWRIGHT_SCREENSHOT_MODES
const RETAINABLE_MODES = PLAYWRIGHT_RETAINED_ARTIFACT_MODES

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

