import { RunOrchestrator } from './runtime/orchestrator'
import type { OrchestratorOptions } from './runtime/run-orchestrator-types'
import { restore } from './runtime/env-switcher/switch'
import type { RunnerLog } from './runtime/runner-log'
import type { prepareRestartResources } from './restart-preparation'
import type { makeAttachRunStreams } from '../run-stream-wiring'

type RestartModeOptions = Pick<OrchestratorOptions,
  'autoHeal' | 'manualHeal' | 'externalHeal' | 'externalHealSession' | 'models' | 'projectRoot'>

export function createRestartedOrchestrator(options: {
  feature: OrchestratorOptions['feature']
  env: OrchestratorOptions['env']
  runId: string
  runDir: string
  initialHealCycles: OrchestratorOptions['initialHealCycles']
  resources: Extract<Awaited<ReturnType<typeof prepareRestartResources>>, { ok: true }>
  ptyFactory: OrchestratorOptions['ptyFactory']
  runnerLog: RunnerLog
  runStateSink: OrchestratorOptions['runStateSink']
  dirtySpecHooks: OrchestratorOptions['dirtySpecHooks']
  attachRunStreams: ReturnType<typeof makeAttachRunStreams>
  modeOptions: RestartModeOptions
  failureLogPrefix: string
}): { ok: true; orch: RunOrchestrator } | { ok: false; reason: 'spawn-failed' } {
  const { feature, env, runId, runDir, initialHealCycles, resources, ptyFactory,
    runnerLog, runStateSink, dirtySpecHooks, attachRunStreams, modeOptions, failureLogPrefix } = options
  let orch: RunOrchestrator
  try {
    orch = new RunOrchestrator({
      feature, env, runId, runDir, initialHealCycles,
      portMap: resources.portMap,
      repoBranchSnapshots: resources.repoBranchSnapshots,
      ptyFactory, runnerLog, runStateSink, dirtySpecHooks,
      ...modeOptions,
    })
  } catch (error) {
    if (resources.backups) restore(resources.backups)
    runnerLog.warn(`${failureLogPrefix}: ${(error as Error).message}`)
    return { ok: false, reason: 'spawn-failed' }
  }
  // Once attached, run completion owns restoration. An attachment error must
  // propagate rather than masquerade as a constructor failure.
  attachRunStreams(orch, runnerLog, feature.name, resources.backups)
  return { ok: true, orch }
}
