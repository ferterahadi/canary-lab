import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import type { RunDetail } from '../../../../../../shared/run-detail'
import type { ExecutionType } from '../../../../../../shared/verification'
import { deriveRunActionAvailability, type RunStatus } from '../../../../../../shared/run-state'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { externalHealRoutes } from '../routes/external-heal'
import { RunStore } from './run-store'
import { createRegistry } from './run-registry'
import { ExternalHealBroker } from './heal/external-heal-broker'
import { registerReadTools } from '../../../mcp/tool-groups/reads'
import { captureTools } from '../../../mcp/tool-groups/__fixtures__/tool-group-harness'
import { buildRunActionsResponse } from './run-actions'

const makeTemp = trackTempDirs('run-actions-')
import { runActionStatuses as statuses, runActionTypes as types, runActionTransients as transients } from '../../../../../../tools/test-helpers/run-action-cases'

function detailFor(status: RunStatus, executionType?: ExecutionType, newRunRequired = false): RunDetail {
  return {
    runId: 'case',
    manifest: { runId: 'case', feature: 'fixture', env: 'local', startedAt: '2026-01-01T00:00:00Z', status, executionType, healCycles: 0, services: [] },
    ...(newRunRequired ? { newRunRequired: true as const } : {}),
    lifecycleEvents: [], playwrightArtifacts: [], playbackEvents: [],
  }
}

it.each(statuses)('keeps browser, HTTP and agent actions consistent for %s', async (status) => {
  const logsDir = makeTemp()
  let detail = detailFor(status)
  const store = new RunStore(logsDir, createRegistry())
  store.get = () => detail
  const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: () => {}, audit: () => {} })
  const app = Fastify()
  await app.register(externalHealRoutes, { store, broker })
  const tools = captureTools(registerReadTools, { store, broker })
  try {
    for (const executionType of types) for (const newRunRequired of [false, true]) {
      detail = detailFor(status, executionType, newRunRequired)
      const expected = deriveRunActionAvailability(status, null, { executionType, newRunRequired })
      expect((await app.inject('/api/runs/case/actions')).json().availability).toEqual(expected)
      expect((await tools.call('get_run_actions', { runId: 'case' })).availability).toEqual(expected)
      for (const transient of transients) {
        const shared = deriveRunActionAvailability(status, transient, { executionType, newRunRequired })
        expect(shared.restartHeal.enabled).toBe(!newRunRequired && executionType !== 'verify' && executionType !== 'boot' && !transient && ['failed', 'aborted'].includes(status))
        expect(shared.stop.enabled).toBe(!transient && ['queued', 'running'].includes(status))
        expect(shared.delete.enabled).toBe(!transient && ['passed', 'failed', 'aborted'].includes(status))
        expect(shared.pauseHeal.enabled).toBe(!transient && status === 'running' && (newRunRequired || !['verify', 'boot'].includes(executionType ?? 'run')))
        expect(shared.cancelHeal.enabled).toBe(!transient && status === 'healing' && (newRunRequired || !['verify', 'boot'].includes(executionType ?? 'run')))
      }
    }
  } finally { await app.close() }
})

it('includes historical disk receipts and manifest-only spent state in both server readers', async () => {
  const logsDir = makeTemp()
  const featureDir = path.join(logsDir, 'fixture')
  fs.mkdirSync(featureDir)
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'exports.config = { name: "fixture", singleAttempt: { receipt: "receipt.json" } }')
  const detail = detailFor('failed')
  detail.manifest.featureDir = featureDir
  const runDir = path.join(logsDir, 'runs', 'case')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'receipt.json'), '{}')
  const store = new RunStore(logsDir, createRegistry())
  store.get = () => detail
  const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: () => {}, audit: () => {} })
  const app = Fastify()
  await app.register(externalHealRoutes, { store, broker })
  const tools = captureTools(registerReadTools, { store, broker })
  try {
    for (const manifestOnly of [false, true]) {
      if (manifestOnly) {
        fs.unlinkSync(path.join(runDir, 'receipt.json'))
        detail.manifest.healEnd = { reason: 'new-run-required', message: 'spent', cycle: 0, at: '2026-01-01T00:00:00Z' }
      }
      expect((await app.inject('/api/runs/case/actions')).json().availability.restartHeal).toEqual({ enabled: false, reason: 'This attempt is spent; start a fresh run after approval.' })
      expect(await tools.call('get_run_actions', { runId: 'case' })).toMatchObject({ availability: { restartHeal: { enabled: false } } })
      expect(buildRunActionsResponse(detail, logsDir, null)).toMatchObject({ signal: { rerun: false, restart: false, heal: false }, evaluationExport: { available: true }, externalClaim: null })
    }
  } finally { await app.close() }
})
