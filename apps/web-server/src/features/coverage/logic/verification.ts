import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import type {
  VerificationConfig,
  VerificationDiagnostics,
  VerificationRunMetadata,
  VerificationTarget,
  VerificationTargetSnapshot,
} from '../../../../../../shared/verification'
import type { PlaywrightArtifactGroup, RunDetail, RunSummaryFailedEntry } from '../../runs/logic/run-store'
import { normalizeStartCommand, resolveHealthProbe } from '../../runs/logic/runtime/launcher/startup'

interface VerificationConfigFile {
  configs: VerificationConfig[]
}

export interface VerificationTargetIndex {
  targets: VerificationTarget[]
  targetUrls: Record<string, string>
}

export interface SaveVerificationConfigInput {
  name: string
  targetUrls: Record<string, string>
  playwrightEnvsetId: string
}

export interface ResolveVerificationInput {
  configId?: string
  targetUrls?: Record<string, string>
  playwrightEnvsetId?: string
}

export interface ResolvedVerificationRun {
  config?: VerificationConfig
  metadata: VerificationRunMetadata
  playwrightEnv: Record<string, string>
}

export function verificationConfigPath(feature: FeatureConfig): string {
  return path.join(feature.featureDir, 'verification.configs.json')
}

export function listVerificationConfigs(feature: FeatureConfig): VerificationConfig[] {
  return readConfigFile(feature).configs
}

export function getVerificationConfig(feature: FeatureConfig, id: string): VerificationConfig | null {
  return listVerificationConfigs(feature).find((config) => config.id === id) ?? null
}

export function createVerificationConfig(
  feature: FeatureConfig,
  input: SaveVerificationConfigInput,
): VerificationConfig {
  const now = new Date().toISOString()
  const config: VerificationConfig = {
    id: randomUUID(),
    featureId: feature.name,
    name: cleanName(input.name),
    targetUrls: cleanTargetUrls(input.targetUrls),
    playwrightEnvsetId: cleanEnvset(input.playwrightEnvsetId),
    createdAt: now,
    updatedAt: now,
  }
  const file = readConfigFile(feature)
  file.configs.push(config)
  writeConfigFile(feature, file)
  return config
}

export function updateVerificationConfig(
  feature: FeatureConfig,
  id: string,
  input: SaveVerificationConfigInput,
): VerificationConfig | null {
  const file = readConfigFile(feature)
  const idx = file.configs.findIndex((config) => config.id === id)
  if (idx === -1) return null
  const current = file.configs[idx]
  const next: VerificationConfig = {
    ...current,
    name: cleanName(input.name),
    targetUrls: cleanTargetUrls(input.targetUrls),
    playwrightEnvsetId: cleanEnvset(input.playwrightEnvsetId),
    updatedAt: new Date().toISOString(),
  }
  file.configs[idx] = next
  writeConfigFile(feature, file)
  return next
}

export function deriveVerificationTargets(
  feature: FeatureConfig,
  playwrightEnvsetId?: string,
): VerificationTargetIndex {
  const envUrls = readEnvsetUrlEntries(feature, playwrightEnvsetId)
  const targets: VerificationTarget[] = []
  const targetUrls: Record<string, string> = {}
  const seenIds = new Map<string, number>()

  const addTarget = (rawId: string, name: string, url?: string): void => {
    const baseId = makeTargetId(rawId)
    const count = seenIds.get(baseId) ?? 0
    seenIds.set(baseId, count + 1)
    const id = count === 0 ? baseId : `${baseId}-${count + 1}`
    const envVar = inferEnvVar(id, rawId, envUrls, targets.length === 0)
    targets.push({
      id,
      name,
      ...(envVar ? { envVar } : {}),
    })
    const resolvedUrl = envVar ? envUrls[envVar] : url
    if (resolvedUrl) targetUrls[id] = resolvedUrl
  }

  for (const repo of feature.repos ?? []) {
    const commands = repo.startCommands ?? []
    if (commands.length === 0) {
      addTarget(repo.name, repo.name)
      continue
    }
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      const rawId = normalized.name!
      const probe = resolveHealthProbe(normalized.healthCheck, playwrightEnvsetId)
      const probeUrl = probe && 'http' in probe ? probe.http.url : undefined
      addTarget(rawId, repo.name, probeUrl)
    }
  }

  if (targets.length === 0) {
    const envVar = singleUrlEnvVar(envUrls)
    targets.push({
      id: 'default',
      name: 'Default target',
      ...(envVar ? { envVar } : {}),
    })
    if (envVar) targetUrls.default = envUrls[envVar]
  }

  return { targets, targetUrls }
}

export function resolveVerificationRun(
  feature: FeatureConfig,
  input: ResolveVerificationInput,
): ResolvedVerificationRun {
  const config = input.configId ? getVerificationConfig(feature, input.configId) : undefined
  if (input.configId && !config) {
    throw Object.assign(new Error(`verification config not found: ${input.configId}`), { statusCode: 404 })
  }
  const playwrightEnvsetId = cleanEnvset(
    input.playwrightEnvsetId
      ?? config?.playwrightEnvsetId
      ?? feature.envs?.[0]
      ?? '',
  )
  if (!playwrightEnvsetId) {
    throw Object.assign(new Error('playwrightEnvsetId is required for verification'), { statusCode: 400 })
  }
  const index = deriveVerificationTargets(feature, playwrightEnvsetId)
  const targetUrls = {
    ...index.targetUrls,
    ...(config?.targetUrls ?? {}),
    ...(input.targetUrls ? cleanTargetUrls(input.targetUrls) : {}),
  }
  const targets: VerificationTargetSnapshot[] = index.targets.map((target) => ({
    ...target,
    url: targetUrls[target.id] ?? '',
  }))
  const playwrightEnv: Record<string, string> = {}
  for (const target of targets) {
    if (target.envVar && target.url) playwrightEnv[target.envVar] = target.url
  }
  return {
    ...(config ? { config } : {}),
    metadata: {
      ...(config ? { configId: config.id, configName: config.name } : {}),
      playwrightEnvsetId,
      targetUrls,
      targets,
    },
    playwrightEnv,
  }
}

export function buildVerificationDiagnostics(
  detail: RunDetail,
  runDir: string,
): VerificationDiagnostics {
  const targetUrls = detail.manifest.verification?.targetUrls ?? {}
  const rawPlaywrightOutput = tail(stripAnsi(safeRead(path.join(runDir, 'playwright.log')) ?? ''), 16_000)
  const failedTests = (detail.summary?.failed ?? []).map((entry) =>
    diagnosticForFailedTest(entry, detail.playwrightArtifacts, runDir, targetUrls),
  )
  return {
    generatedAt: new Date().toISOString(),
    summary: failedTests.length === 0
      ? 'Verification failed, but no failed Playwright test was recorded.'
      : `${failedTests.length} Playwright test${failedTests.length === 1 ? '' : 's'} failed during deployment verification.`,
    targetUrls,
    failedTests,
    ...(rawPlaywrightOutput ? { rawPlaywrightOutput } : {}),
  }
}

function diagnosticForFailedTest(
  entry: RunSummaryFailedEntry,
  artifactGroups: PlaywrightArtifactGroup[] | undefined,
  runDir: string,
  targetUrls: Record<string, string>,
) {
  const traceSummary = readTraceSummary(runDir, entry)
  const networkErrors = readTraceExtractLines(runDir, entry, 'network-failed.txt')
  const consoleErrors = readTraceExtractLines(runDir, entry, 'console-errors.txt')
  const combined = [entry.error?.message, entry.error?.snippet, traceSummary, ...networkErrors, ...consoleErrors]
    .filter((value): value is string => Boolean(value))
    .join('\n')
  const endpoint = firstUrl(combined)
  const targetUrl = targetForEndpoint(endpoint, targetUrls) ?? Object.values(targetUrls).find(Boolean)
  const group = artifactGroups?.find((candidate) => candidate.testName === entry.name)
  return {
    name: entry.name,
    ...(entry.location ? { location: entry.location } : {}),
    ...(entry.location ? { testFile: entry.location.split(':')[0] } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(httpStatusFrom(combined) ? { httpStatus: httpStatusFrom(combined) } : {}),
    ...(entry.error?.message ? { errorMessage: entry.error.message } : {}),
    ...(entry.error?.snippet ? { assertionFailure: entry.error.snippet } : {}),
    ...(consoleErrors.length ? { consoleErrors } : {}),
    ...(networkErrors.length ? { networkErrors } : {}),
    ...(combined ? { rawPlaywrightError: tail(combined, 8_000) } : {}),
    ...(group?.artifacts.length
      ? {
          artifacts: group.artifacts.map((artifact) => ({
            name: artifact.name,
            kind: artifact.kind,
            url: artifact.url,
          })),
        }
      : {}),
  }
}

function readConfigFile(feature: FeatureConfig): VerificationConfigFile {
  const file = verificationConfigPath(feature)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as VerificationConfigFile
    return {
      configs: Array.isArray(parsed.configs)
        ? parsed.configs.filter(isVerificationConfig)
        : [],
    }
  } catch {
    return { configs: [] }
  }
}

function writeConfigFile(feature: FeatureConfig, file: VerificationConfigFile): void {
  const target = verificationConfigPath(feature)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ configs: file.configs }, null, 2) + '\n')
  fs.renameSync(tmp, target)
}

function isVerificationConfig(value: unknown): value is VerificationConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as VerificationConfig
  return typeof config.id === 'string'
    && typeof config.featureId === 'string'
    && typeof config.name === 'string'
    && typeof config.playwrightEnvsetId === 'string'
    && typeof config.createdAt === 'string'
    && typeof config.updatedAt === 'string'
    && Boolean(config.targetUrls)
    && typeof config.targetUrls === 'object'
}

function cleanName(value: string): string {
  const name = value.trim()
  if (!name) throw Object.assign(new Error('verification config name is required'), { statusCode: 400 })
  return name
}

function cleanEnvset(value: string): string {
  return value.trim()
}

function cleanTargetUrls(value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value ?? {})) {
    const id = key.trim()
    const url = String(raw ?? '').trim()
    if (id && url) out[id] = url
  }
  return out
}

function makeTargetId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'service'
}

function envKeyStem(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function inferEnvVar(
  id: string,
  rawId: string,
  urls: Record<string, string>,
  firstTarget: boolean,
): string | undefined {
  const keys = Object.keys(urls)
  const candidates = [
    `${envKeyStem(id)}_URL`,
    `${envKeyStem(rawId)}_URL`,
    `${envKeyStem(id)}_TARGET_URL`,
    `${envKeyStem(rawId)}_TARGET_URL`,
  ]
  for (const candidate of candidates) {
    if (candidate in urls) return candidate
  }
  const idStem = envKeyStem(id)
  const fuzzy = keys.find((key) => key.includes(idStem) && key.endsWith('_URL'))
  if (fuzzy) return fuzzy
  const single = singleUrlEnvVar(urls)
  return firstTarget ? single : undefined
}

function singleUrlEnvVar(urls: Record<string, string>): string | undefined {
  const keys = Object.keys(urls)
  return keys.length === 1 ? keys[0] : undefined
}

function readEnvsetUrlEntries(feature: FeatureConfig, envsetId: string | undefined): Record<string, string> {
  if (!envsetId) return {}
  const envsetsDir = path.join(feature.featureDir, 'envsets')
  const setDir = path.join(envsetsDir, envsetId)
  if (!fs.existsSync(setDir)) return {}
  const out: Record<string, string> = {}
  for (const file of listFiles(setDir)) {
    const raw = safeRead(file)
    if (!raw) continue
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line)
      if (!parsed) continue
      const { key, value } = parsed
      if (!/^https?:\/\//i.test(value)) continue
      if (!/(^|_)URL$|TARGET_URL|BASE_URL|GATEWAY_URL/.test(key)) continue
      out[key] = value
    }
  }
  return out
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const idx = trimmed.indexOf('=')
  if (idx <= 0) return null
  const key = trimmed.slice(0, idx).trim()
  let value = trimmed.slice(idx + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

function listFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function readTraceSummary(runDir: string, entry: RunSummaryFailedEntry): string | null {
  const traceSummaryFile = (entry as RunSummaryFailedEntry & { traceSummaryFile?: string }).traceSummaryFile
  if (!traceSummaryFile) return null
  return safeRead(path.join(runDir, traceSummaryFile))
}

function readTraceExtractLines(runDir: string, entry: RunSummaryFailedEntry, filename: string): string[] {
  const traceSummaryFile = (entry as RunSummaryFailedEntry & { traceSummaryFile?: string }).traceSummaryFile
  if (!traceSummaryFile) return []
  const extractDir = path.join(runDir, path.dirname(traceSummaryFile), 'trace-extract')
  const raw = safeRead(path.join(extractDir, filename))
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function firstUrl(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s)'"]+/)?.[0]
}

function targetForEndpoint(endpoint: string | undefined, targetUrls: Record<string, string>): string | undefined {
  if (!endpoint) return undefined
  for (const target of Object.values(targetUrls)) {
    if (target && endpoint.startsWith(target)) return target
  }
  return undefined
}

function httpStatusFrom(value: string): number | undefined {
  const match = value.match(/\b([1-5]\d\d)\b/)
  return match ? Number(match[1]) : undefined
}

function safeRead(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8') } catch { return null }
}

function tail(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}
