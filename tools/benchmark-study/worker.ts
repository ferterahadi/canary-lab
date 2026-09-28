import fs from 'node:fs'
import path from 'node:path'
import { json, readJson } from './files'
import type { Attempt, ExecutionResult, StudyManifest, UsageAttribution } from './types'
import { runtimeEnvironment } from './runtime'
import { startTelemetry } from './telemetry'
import { assessPolicy } from './attribution'

async function main(): Promise<void> {
  const [study, id] = process.argv.slice(2)
  const manifest = readJson<StudyManifest>(study)
  const attempt: Attempt | undefined = manifest.attempts.find((item) => item.id === id)
  if (!attempt) throw new Error(`Unknown attempt: ${id}`)
  const root = path.join(manifest.root, 'attempts', id)
  delete process.env.CANARY_LAB_HEAL_MODEL
  delete process.env.CANARY_LAB_BENCHMARK_MODE
  process.env.CANARY_LAB_PROJECT_ROOT = root
  Object.assign(process.env, runtimeEnvironment(root))
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  const timer = setTimeout(() => controller.abort(), manifest.budgetMs)
  const started = Date.now()
  let result: ExecutionResult
  let telemetry: Awaited<ReturnType<typeof startTelemetry>> | undefined
  try {
    if (manifest.design?.mode === 'replay') {
      const { runReplay } = await import('./replay')
      result = await runReplay(manifest, attempt, root, controller.signal)
    } else {
      telemetry = await startTelemetry(root, attempt.agent)
      for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_') || key.startsWith('BETA_TRACING_') || key === 'ENABLE_BETA_TRACING_DETAILED') delete process.env[key]
      Object.assign(process.env, telemetry.env)
      manifest.codexToolArgs = [...(manifest.codexToolArgs ?? []), ...telemetry.codexArgs]
      const { runCanary, runPlain } = await import('./agents')
      result = await (attempt.workflow === 'canary' ? runCanary : runPlain)(manifest, attempt, root, controller.signal)
    }
    if (Date.now() - started >= manifest.budgetMs) result.status = 'timeout'
  } catch (error) {
    result = { status: controller.signal.aborted ? 'interrupted' : 'infrastructure-error', reason: String(error), usage: null, testExecutions: null }
  } finally { clearTimeout(timer) }
  const usageFile = path.join(root, 'usage-breakdown.json')
  if (fs.existsSync(usageFile)) {
    result.attribution = readJson<UsageAttribution>(usageFile)
    result.usage = result.attribution.total
    if (attempt.variant) result.adherence = assessPolicy(attempt.variant.diagnosisPolicy, result.attribution)
  }
  if (telemetry) result.telemetry = await telemetry.close()
  json(path.join(root, 'execution.json'), result)
}
main().catch((error) => { fs.writeSync(2, `${String(error)}\n`); process.exitCode = 1 })
