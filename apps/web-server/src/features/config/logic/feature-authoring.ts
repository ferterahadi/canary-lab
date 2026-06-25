import fs from 'fs'
import path from 'path'
import {
  buildFeatureSkeletonScaffold,
  validateFeatureTarget,
  validateGeneratedSpecFiles,
  type FeatureScaffoldRepo,
  type GeneratedFeatureFile,
} from '../../../../../../shared/feature-scaffold'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import { loadFeatures } from './feature-loader'
import { checkoutBranch, findRepo, getGitStatus, resolveRepoPath } from '../../../shared/git-repo'
import { readFeatureConfig, writeFeatureConfig, type ConfigValue } from '../../config/logic/config-ast'

export interface FeatureAuthoringContext {
  projectRoot: string
  featuresDir: string
}

export interface EnvFileSource {
  sourcePath: string
  env?: string
  slot?: string
  target?: string
  description?: string
  confirmOverwrite?: boolean
}

export interface RedactedEntry {
  key: string
  value: '********'
}

export interface CapturedEnvFile {
  env: string
  slot: string
  sourcePath: string
  target: string
  writtenPath: string
  preview: RedactedEntry[]
}

export interface FeatureEnvsetSummary {
  feature: string
  featureDir: string
  configPath: string | null
  // Declared repos (name + local path + expected branch), so an agent that
  // drilled in via this summary has the repo name in hand for the repo-targeted
  // tools (get_feature_repo_status, checkout_feature_repo_branch) without a
  // separate list_features round-trip. Mirrors the list_features repo shape.
  repos: Array<{ name: string; localPath: string; branch: string | null }>
  envs: Array<{
    name: string
    slots: Array<{
      slot: string
      target?: string
      description?: string
      preview: RedactedEntry[]
    }>
  }>
}

interface EnvsetsConfigJson {
  appRoots?: Record<string, string>
  slots?: Record<string, { description?: string; target?: string }>
  feature?: {
    slots?: string[]
    testCommand?: string
    testCwd?: string
  }
}

export function createFeatureSkeleton(input: FeatureAuthoringContext & {
  feature: string
  description?: string
  envs?: string[]
  repos?: FeatureScaffoldRepo[]
}): {
  ok: true
  feature: string
  featureDir: string
  written: string[]
  nextSteps: string[]
  testFileRules: Record<string, unknown>
  envsetSchema: Record<string, unknown>
} | { ok: false; error: string; featureDir?: string } {
  const validation = validateFeatureTarget(input.projectRoot, input.feature)
  if (!validation.ok) return { ok: false, error: validation.error, featureDir: validation.featureDir }
  const files = buildFeatureSkeletonScaffold({
    featureName: input.feature,
    description: input.description,
    envs: input.envs,
    repos: input.repos,
  })
  const featureDir = validation.featureDir
  const written: string[] = []
  for (const file of files) {
    const target = path.join(featureDir, file.path)
    /* v8 ignore next 3 -- buildFeatureSkeletonScaffold emits validated package-owned paths. */
    if (!isWithin(featureDir, target)) return { ok: false, error: `file escapes feature directory: ${file.path}` }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
    written.push(target)
  }
  for (const env of sanitizeEnvNames(input.envs)) {
    fs.mkdirSync(path.join(featureDir, 'envsets', env), { recursive: true })
  }
  return {
    ok: true,
    feature: input.feature,
    featureDir,
    written,
    nextSteps: ['capture_feature_env_files', 'start_external_draft', 'apply_external_draft'],
    testFileRules: externalTestFileRules(),
    envsetSchema: envsetSchema(input.feature),
  }
}

export function getFeatureEnvsetSummary(ctx: FeatureAuthoringContext, featureName: string): FeatureEnvsetSummary | null {
  const feature = findFeature(ctx.featuresDir, featureName)
  if (!feature?.featureDir) return null
  const envsetsDir = path.join(feature.featureDir, 'envsets')
  const configPath = path.join(envsetsDir, 'envsets.config.json')
  const cfg = readEnvsetsConfig(envsetsDir)
  const envs = fs.existsSync(envsetsDir)
    ? fs.readdirSync(envsetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : []
  return {
    feature: feature.name,
    featureDir: feature.featureDir,
    configPath: fs.existsSync(configPath) ? configPath : null,
    repos: (feature.repos ?? []).map((r) => ({ name: r.name, localPath: r.localPath, branch: r.branch ?? null })),
    envs: envs.map((env) => ({
      name: env,
      slots: listSlotFiles(path.join(envsetsDir, env)).map((slot) => ({
        slot,
        target: cfg.slots?.[slot]?.target,
        description: cfg.slots?.[slot]?.description,
        preview: parseRedactedEntries(fs.readFileSync(path.join(envsetsDir, env, slot), 'utf8')),
      })),
    })),
  }
}

export function captureFeatureEnvFiles(ctx: FeatureAuthoringContext, input: {
  feature: string
  sources: EnvFileSource[]
}): { ok: true; captured: CapturedEnvFile[]; summary: FeatureEnvsetSummary } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  if (!Array.isArray(input.sources) || input.sources.length === 0) return { ok: false, error: 'sources[] required' }

  const envsetsDir = path.join(feature.featureDir, 'envsets')
  const cfg = readEnvsetsConfig(envsetsDir)
  cfg.appRoots ??= {}
  cfg.slots ??= {}
  cfg.feature ??= {
    slots: [],
    testCommand: 'npx playwright test',
    testCwd: `$CANARY_LAB_PROJECT_ROOT/features/${feature.name}`,
  }
  cfg.feature.slots ??= []

  const captured: CapturedEnvFile[] = []
  const envs = new Set(feature.envs ?? [])
  for (const source of input.sources) {
    const sourcePath = path.resolve(source.sourcePath)
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return { ok: false, error: `source file not found: ${source.sourcePath}` }
    }
    const env = sanitizeEnvName(source.env == null ? 'local' : source.env)
    const slot = sanitizeSlotName(source.slot ?? path.basename(sourcePath))
    const envDir = path.join(envsetsDir, env)
    const dest = path.join(envDir, slot)
    /* v8 ignore next 2 -- sanitizeSlotName rejects path traversal before this guard. */
    if (!isWithin(envsetsDir, dest)) return { ok: false, error: `slot escapes envsets directory: ${slot}` }
    if (fs.existsSync(dest) && source.confirmOverwrite !== true) {
      return { ok: false, error: `slot already exists; pass confirmOverwrite: true to overwrite ${env}/${slot}` }
    }
    const raw = fs.readFileSync(sourcePath, 'utf8')
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(dest, raw, 'utf8')
    const trimmedTarget = source.target == null ? '' : source.target.trim()
    const target = trimmedTarget || sourcePath
    cfg.slots[slot] = {
      description: source.description?.trim() || `Captured from ${sourcePath}`,
      target,
    }
    if (!cfg.feature.slots.includes(slot)) cfg.feature.slots.push(slot)
    envs.add(env)
    captured.push({
      env,
      slot,
      sourcePath,
      target,
      writtenPath: dest,
      preview: parseRedactedEntries(raw),
    })
  }
  writeEnvsetsConfig(envsetsDir, cfg)
  syncFeatureEnvs(feature.featureDir, Array.from(envs).sort())
  const summary = getFeatureEnvsetSummary(ctx, input.feature)
  return { ok: true, captured, summary: summary! }
}

export async function getFeatureRepoStatus(ctx: FeatureAuthoringContext, featureName: string, repoName: string): Promise<Record<string, unknown> | null> {
  const feature = findFeature(ctx.featuresDir, featureName)
  if (!feature) return null
  const repo = findRepo(feature, repoName)
  if (!repo) return null
  return {
    ...await getGitStatus(repo.localPath),
    path: resolveRepoPath(repo.localPath),
    expectedBranch: repo.branch ?? null,
  }
}

export async function checkoutFeatureRepoBranch(ctx: FeatureAuthoringContext, input: {
  feature: string
  repo: string
  branch: string
  confirm: true
}): Promise<Record<string, unknown> | { error: string; statusCode: number }> {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature) return { error: 'feature not found', statusCode: 404 }
  const repo = findRepo(feature, input.repo)
  if (!repo) return { error: 'repo not found', statusCode: 404 }
  try {
    return {
      ...await checkoutBranch(repo.localPath, input.branch.trim()),
      path: resolveRepoPath(repo.localPath),
      expectedBranch: repo.branch ?? null,
    }
  } catch (err) {
    return {
      /* v8 ignore next 2 -- checkoutBranch rejects with Error instances. */
      error: err instanceof Error ? err.message : String(err),
      /* v8 ignore next 3 -- checkoutBranch attaches statusCode to expected failures. */
      statusCode: typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500,
    }
  }
}

export function deleteFeature(ctx: FeatureAuthoringContext, input: {
  feature: string
  confirmName: string
}): { ok: true; featureDir: string } | { ok: false; error: string; featureDir?: string } {
  if (input.confirmName !== input.feature) return { ok: false, error: 'confirmName must match the feature name' }
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  const featuresRoot = path.resolve(ctx.featuresDir)
  const featureDir = path.resolve(feature.featureDir)
  if (featureDir === featuresRoot || !isWithin(featuresRoot, featureDir)) {
    return { ok: false, error: 'feature directory is outside the features root', featureDir }
  }
  fs.rmSync(featureDir, { recursive: true, force: true })
  return { ok: true, featureDir }
}

export function applyExternalDraftFiles(input: {
  featureDir: string
  files?: GeneratedFeatureFile[]
}): { ok: true; written: string[] } | { ok: false; error: string } {
  const files = input.files ?? readExistingSpecFiles(input.featureDir)
  const validation = validateGeneratedSpecFiles(files)
  if (!validation.ok) return { ok: false, error: validation.error }
  const written: string[] = []
  for (const file of files) {
    const target = path.join(input.featureDir, file.path)
    /* v8 ignore next 3 -- validateGeneratedSpecFiles rejects escaping paths before writes. */
    if (!isWithin(input.featureDir, target)) return { ok: false, error: `file escapes feature directory: ${file.path}` }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
    written.push(target)
  }
  return { ok: true, written }
}

// Write a prose doc (distilled session, plan, notes) into a feature's `docs/`
// directory. The one home for feature-scoped documentation — the scaffold
// otherwise has no place for it, and the draft-apply path rejects non-spec
// files. Create-or-replace: the caller picks a slug; re-writing the same
// relPath overwrites. Markdown only; path-traversal hardened.
export function writeFeatureDoc(ctx: FeatureAuthoringContext, input: {
  feature: string
  relPath: string
  content: string
}): { ok: true; writtenPath: string; relativePath: string } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    return { ok: false, error: 'content must be a non-empty string' }
  }
  const resolved = resolveDocRelPath(input.relPath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const docsDir = path.join(feature.featureDir, 'docs')
  const dest = path.join(docsDir, resolved.rel)
  if (!isWithin(docsDir, dest)) return { ok: false, error: 'relPath must not escape the docs directory' }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, input.content, 'utf8')
  return { ok: true, writtenPath: dest, relativePath: path.relative(feature.featureDir, dest) }
}

// Delete a SOURCE doc from a feature's `docs/`. Refuses generated artifacts
// (`_`-prefixed: _prd-*, _coverage-*) — those are engine-managed, not user docs —
// and is path-traversal hardened the same way as writeFeatureDoc.
export function deleteFeatureDoc(ctx: FeatureAuthoringContext, input: {
  feature: string
  relPath: string
}): { ok: true; relativePath: string } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  const resolved = resolveDocRelPath(input.relPath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (path.basename(resolved.rel).startsWith('_')) {
    return { ok: false, error: 'cannot delete a generated artifact' }
  }
  const docsDir = path.join(feature.featureDir, 'docs')
  const dest = path.join(docsDir, resolved.rel)
  if (!isWithin(docsDir, dest)) return { ok: false, error: 'relPath must not escape the docs directory' }
  if (!fs.existsSync(dest)) return { ok: false, error: 'doc not found' }
  fs.rmSync(dest)
  return { ok: true, relativePath: path.relative(feature.featureDir, dest) }
}

export function externalTestFileRules(): Record<string, unknown> {
  return {
    specs: 'Place Playwright specs directly under e2e/*.spec.ts.',
    requiredImport: 'canary-lab/feature-support/log-marker-fixture',
    noInternalAgentSpawn: true,
  }
}

export function envsetSchema(feature: string): Record<string, unknown> {
  return {
    configPath: `features/${feature}/envsets/envsets.config.json`,
    valueFiles: `features/${feature}/envsets/<env>/<slot>`,
    configShape: {
      appRoots: { REPO_VAR: '/absolute/path/to/repo' },
      slots: { 'slot-name.ext': { description: 'human label', target: '/absolute/path/or/$APPROOT/file' } },
      feature: {
        slots: ['slot-name.ext'],
        testCommand: 'npx playwright test',
        testCwd: `$CANARY_LAB_PROJECT_ROOT/features/${feature}`,
      },
    },
  }
}

export function parseRedactedEntries(raw: string): RedactedEntry[] {
  const keys = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const dotenv = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/)
    const properties = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]/)
    const key = dotenv?.[1] ?? properties?.[1]
    if (key) keys.add(key)
  }
  return Array.from(keys).sort().map((key) => ({ key, value: '********' as const }))
}

function findFeature(featuresDir: string, featureName: string): FeatureConfig | undefined {
  return loadFeatures(featuresDir).find((feature) => feature.name === featureName)
}

// Resolve a caller-supplied doc path to a path relative to the feature's
// `docs/` dir. Accepts an optional leading `docs/` so both "notes.md" and
// "docs/notes.md" land in the same place. Rejects absolute paths and
// non-markdown extensions; traversal is caught by the `isWithin` guard at the
// call site (so `../x.md` resolves and then fails the within-docs check).
function resolveDocRelPath(relPath: string): { ok: true; rel: string } | { ok: false; error: string } {
  const trimmed = (relPath ?? '').trim()
  if (!trimmed) return { ok: false, error: 'relPath required' }
  if (path.isAbsolute(trimmed)) return { ok: false, error: 'relPath must be relative' }
  const rel = trimmed.replace(/^\.?[/\\]?docs[/\\]/i, '')
  if (!/\.(md|markdown)$/i.test(rel)) {
    return { ok: false, error: 'relPath must end in .md or .markdown' }
  }
  return { ok: true, rel }
}

function readEnvsetsConfig(envsetsDir: string): EnvsetsConfigJson {
  const cfgPath = path.join(envsetsDir, 'envsets.config.json')
  if (!fs.existsSync(cfgPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as EnvsetsConfigJson
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeEnvsetsConfig(envsetsDir: string, cfg: EnvsetsConfigJson): void {
  fs.mkdirSync(envsetsDir, { recursive: true })
  fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

function syncFeatureEnvs(featureDir: string, envs: string[]): void {
  const configPath = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']
    .map((name) => path.join(featureDir, name))
    .find((candidate) => fs.existsSync(candidate))
  if (!configPath) return
  const source = fs.readFileSync(configPath, 'utf8')
  const parsed = readFeatureConfig(source)
  /* v8 ignore next 2 -- loaded feature configs are object exports; this is defensive for stale hand edits. */
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return
  const next = { ...(parsed.value as Record<string, ConfigValue>), envs } as ConfigValue
  fs.writeFileSync(configPath, writeFeatureConfig(source, next), 'utf8')
}

function listSlotFiles(envDir: string): string[] {
  if (!fs.existsSync(envDir)) return []
  return fs.readdirSync(envDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

function readExistingSpecFiles(featureDir: string): GeneratedFeatureFile[] {
  const e2eDir = path.join(featureDir, 'e2e')
  if (!fs.existsSync(e2eDir)) return []
  return fs.readdirSync(e2eDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => ({
      path: `e2e/${entry.name}`,
      content: fs.readFileSync(path.join(e2eDir, entry.name), 'utf8'),
    }))
}

function sanitizeEnvNames(envs: string[] | undefined): string[] {
  const clean = (envs ?? ['local']).map((env) => sanitizeEnvName(env)).filter(Boolean)
  return Array.from(new Set(clean.length > 0 ? clean : ['local']))
}

function sanitizeEnvName(env: string): string {
  const clean = env.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) throw new Error(`invalid env name: ${env}`)
  return clean
}

function sanitizeSlotName(slot: string): string {
  const clean = slot.trim()
  if (!clean || path.isAbsolute(clean) || clean.includes('/') || clean.includes('\\') || clean === '..' || clean.includes('..')) {
    throw new Error(`invalid slot name: ${slot}`)
  }
  return clean
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
