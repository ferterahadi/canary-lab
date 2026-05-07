import fs from 'fs'
import path from 'path'

export const CANONICAL_PLAYWRIGHT_CONFIG = 'playwright.config.ts'
export const LOG_MARKER_FIXTURE_IMPORT = 'canary-lab/feature-support/log-marker-fixture'

export interface GeneratedFeatureFile {
  path: string
  content: string
}

export interface BuildFeatureScaffoldInput {
  featureName: string
  description?: string
}

export type ValidateGeneratedFeatureResult =
  | { ok: true }
  | { ok: false; error: string }

export type ApplyFeatureScaffoldResult =
  | { ok: true; featureDir: string; written: string[] }
  | { ok: false; error: 'feature-exists' | 'invalid-name' | 'invalid-scaffold'; featureDir?: string; details?: string }

const FEATURE_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function isValidFeatureName(name: string): boolean {
  return FEATURE_NAME_RE.test(name)
}

export function canonicalScaffoldPaths(featureName: string): string[] {
  return [
    'feature.config.cjs',
    CANONICAL_PLAYWRIGHT_CONFIG,
    'envsets/envsets.config.json',
    `envsets/local/${featureName}.env`,
    `e2e/${featureName}.spec.ts`,
  ]
}

export function buildFeatureScaffold(input: BuildFeatureScaffoldInput): GeneratedFeatureFile[] {
  const description = input.description?.trim() || 'TODO: add description'
  return [
    { path: 'feature.config.cjs', content: buildFeatureConfig(input.featureName, description) },
    { path: CANONICAL_PLAYWRIGHT_CONFIG, content: buildPlaywrightConfig() },
    { path: 'envsets/envsets.config.json', content: buildEnvsetsConfig(input.featureName) },
    { path: `envsets/local/${input.featureName}.env`, content: 'GATEWAY_URL=http://localhost:3000\n' },
    { path: `e2e/${input.featureName}.spec.ts`, content: buildSpec(input.featureName) },
  ]
}

export function validateGeneratedFeatureFiles(
  featureName: string,
  files: GeneratedFeatureFile[],
): ValidateGeneratedFeatureResult {
  if (!isValidFeatureName(featureName)) return { ok: false, error: `invalid feature name "${featureName}"` }
  if (files.length === 0) return { ok: false, error: 'no generated files' }

  const byPath = new Map<string, string>()
  for (const file of files) {
    const pathResult = validateRelativePath(file.path)
    if (!pathResult.ok) return pathResult
    if (byPath.has(file.path)) return { ok: false, error: `duplicate generated file "${file.path}"` }
    byPath.set(file.path, file.content)
  }

  for (const required of [
    'feature.config.cjs',
    CANONICAL_PLAYWRIGHT_CONFIG,
    'envsets/envsets.config.json',
    `envsets/local/${featureName}.env`,
  ]) {
    if (!byPath.has(required)) return { ok: false, error: `missing required file "${required}"` }
  }

  if (!files.some((file) => /^e2e\/[^/]+\.spec\.ts$/.test(file.path))) {
    return { ok: false, error: 'missing required e2e/*.spec.ts file' }
  }

  for (const file of files) {
    if (file.path.endsWith('.spec.ts')) {
      if (!file.path.startsWith('e2e/') || file.path.split('/').length !== 2) {
        return { ok: false, error: `spec file "${file.path}" must live directly under e2e/` }
      }
      if (!file.content.includes(LOG_MARKER_FIXTURE_IMPORT)) {
        return { ok: false, error: `spec file "${file.path}" must import ${LOG_MARKER_FIXTURE_IMPORT}` }
      }
    }
  }

  const featureConfig = byPath.get('feature.config.cjs')!
  const featureConfigResult = validateFeatureConfigText(featureName, featureConfig)
  if (!featureConfigResult.ok) return featureConfigResult

  const envsetsResult = validateEnvsetsConfig(byPath.get('envsets/envsets.config.json')!)
  if (!envsetsResult.ok) return envsetsResult

  return { ok: true }
}

export function validateFeatureTarget(projectRoot: string, featureName: string): ApplyFeatureScaffoldResult {
  if (!isValidFeatureName(featureName)) return { ok: false, error: 'invalid-name' }
  const featureDir = path.join(projectRoot, 'features', featureName)
  if (fs.existsSync(featureDir)) return { ok: false, error: 'feature-exists', featureDir }
  return { ok: true, featureDir, written: [] }
}

export function applyFeatureScaffold(input: {
  featureName: string
  files: GeneratedFeatureFile[]
  projectRoot: string
}): ApplyFeatureScaffoldResult {
  const validation = validateFeatureTarget(input.projectRoot, input.featureName)
  if (!validation.ok) return validation
  const scaffold = validateGeneratedFeatureFiles(input.featureName, input.files)
  if (!scaffold.ok) return { ok: false, error: 'invalid-scaffold', details: scaffold.error }

  const featureDir = validation.featureDir
  fs.mkdirSync(featureDir, { recursive: true })
  const written: string[] = []
  for (const file of input.files) {
    const target = path.join(featureDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
    written.push(target)
  }
  return { ok: true, featureDir, written }
}

function validateRelativePath(filePath: string): ValidateGeneratedFeatureResult {
  if (!filePath) return { ok: false, error: 'file path empty' }
  if (path.isAbsolute(filePath)) return { ok: false, error: `file path "${filePath}" must be relative` }
  const normalized = path.normalize(filePath)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    return { ok: false, error: `file path "${filePath}" must stay inside the feature directory` }
  }
  if (normalized !== filePath.split('/').join(path.sep)) {
    return { ok: false, error: `file path "${filePath}" must be normalized` }
  }
  return { ok: true }
}

function validateFeatureConfigText(featureName: string, content: string): ValidateGeneratedFeatureResult {
  const checks: Array<[RegExp, string]> = [
    [new RegExp(`name\\s*:\\s*['"]${escapeRegExp(featureName)}['"]`), `feature.config.cjs must set name to "${featureName}"`],
    [/envs\s*:\s*\[/, 'feature.config.cjs must declare envs'],
    [/repos\s*:\s*\[/, 'feature.config.cjs must declare repos'],
    [/featureDir\s*:\s*__dirname/, 'feature.config.cjs must set featureDir: __dirname'],
    [/module\.exports\s*=\s*\{\s*config\s*\}/, 'feature.config.cjs must export { config }'],
  ]
  for (const [pattern, error] of checks) {
    if (!pattern.test(content)) return { ok: false, error }
  }
  return { ok: true }
}

function validateEnvsetsConfig(content: string): ValidateGeneratedFeatureResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return { ok: false, error: `envsets/envsets.config.json is invalid JSON: ${(err as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'envsets/envsets.config.json must be an object' }
  }
  const obj = parsed as Record<string, unknown>
  if ('envsets' in obj) return { ok: false, error: 'envsets/envsets.config.json must not use stale envsets shape' }
  if (!isRecord(obj.appRoots)) return { ok: false, error: 'envsets/envsets.config.json must declare appRoots object' }
  if (!isRecord(obj.slots)) return { ok: false, error: 'envsets/envsets.config.json must declare slots object' }
  if (!isRecord(obj.feature)) return { ok: false, error: 'envsets/envsets.config.json must declare feature object' }
  const feature = obj.feature as Record<string, unknown>
  if (!Array.isArray(feature.slots)) return { ok: false, error: 'envsets feature.slots must be an array' }
  if (typeof feature.testCommand !== 'string' || !feature.testCommand.trim()) {
    return { ok: false, error: 'envsets feature.testCommand must be a non-empty string' }
  }
  if (typeof feature.testCwd !== 'string' || !feature.testCwd.trim()) {
    return { ok: false, error: 'envsets feature.testCwd must be a non-empty string' }
  }
  return { ok: true }
}

function buildFeatureConfig(name: string, description: string): string {
  return `const config = {
  name: '${name}',
  description: '${escapeSingleQuoted(description)}',
  envs: ['local'],
  repos: [],
  featureDir: __dirname,
}

module.exports = { config }
`
}

function buildPlaywrightConfig(): string {
  return `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

loadDotenv({ path: path.join(__dirname, '.env') })

export default defineConfig({ ...baseConfig })
`
}

function buildEnvsetsConfig(name: string): string {
  return JSON.stringify(
    {
      appRoots: {},
      slots: {
        [`${name}.env`]: {
          description: `Canary Lab ${name} feature .env`,
          target: `$CANARY_LAB_PROJECT_ROOT/features/${name}/.env`,
        },
      },
      feature: {
        slots: [`${name}.env`],
        testCommand: 'npx playwright test',
        testCwd: `$CANARY_LAB_PROJECT_ROOT/features/${name}`,
      },
    },
    null,
    2,
  ) + '\n'
}

function buildSpec(name: string): string {
  return `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

test.describe('${name}', () => {
  test('example test', async () => {
    expect(true).toBe(true)
  })
})
`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
