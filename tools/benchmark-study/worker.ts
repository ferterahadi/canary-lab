import fs from 'node:fs'
import path from 'node:path'
import { json, readJson } from './files'
import type { Attempt, ExecutionResult, UsageAttribution } from './types'
import { runtimeEnvironment } from './runtime'
import { startTelemetry } from './telemetry'
import { recoverWorkerEvidence } from './worker-evidence'
import { loadStudy } from './study'
import { assertRepositoryWorkerOwner, watchRepositoryOwner } from './repository/worker-owner'

async function main(): Promise<void> {
  const [study, id] = process.argv.slice(2)
  const manifest = loadStudy(path.dirname(study))
  const attempt: Attempt | undefined = manifest.attempts.find((item) => item.id === id)
  if (!attempt) throw new Error(`Unknown attempt: ${id}`)
  if (manifest.repository) {
    assertRepositoryWorkerOwner(manifest, id, process.argv.includes('--owner-lease'))
  }
  const root = path.join(manifest.root, 'attempts', id)
  delete process.env.CANARY_LAB_HEAL_MODEL
  delete process.env.CANARY_LAB_BENCHMARK_MODE
  process.env.CANARY_LAB_PROJECT_ROOT = root
  Object.assign(process.env, runtimeEnvironment(root))
  const controller = new AbortController()
  // The owner holds the write end of FD 3. EOF binds liveness to that exact
  // scheduler process, so an orphan worker cannot keep spending after a crash.
  const lease = process.argv.includes('--owner-lease') ? watchRepositoryOwner(() => controller.abort()) : undefined
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  const timer = setTimeout(() => controller.abort(), manifest.budgetMs)
  const started = Date.now()
  let result: ExecutionResult
  let telemetry: Awaited<ReturnType<typeof startTelemetry>> | undefined
  try {
    if (manifest.repository) {
      if (manifest.design?.mode !== 'replay') {
        const { assertRepositoryAuthorization } = await import('./repository/campaign')
        assertRepositoryAuthorization(manifest)
        telemetry = await startTelemetry(root, attempt.agent)
        for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_') || key.startsWith('BETA_TRACING_') || key === 'ENABLE_BETA_TRACING_DETAILED') delete process.env[key]
        Object.assign(process.env, telemetry.env)
      }
      const { runRepositoryAgent } = await import('./repository/agent')
      result = await runRepositoryAgent(manifest, attempt, root, controller.signal, telemetry?.codexArgs ?? [])
    } else if (manifest.design?.mode === 'replay') {
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
  } finally { clearTimeout(timer); lease?.destroy() }
  const usageFile = path.join(root, 'usage-breakdown.json')
  if (fs.existsSync(usageFile)) {
    result = recoverWorkerEvidence(result, attempt, readJson<UsageAttribution>(usageFile))
  }
  if (telemetry) result.telemetry = await telemetry.close()
  json(path.join(root, 'execution.json'), result)
}
main().catch((error) => { fs.writeSync(2, `${String(error)}\n`); process.exitCode = 1 })
