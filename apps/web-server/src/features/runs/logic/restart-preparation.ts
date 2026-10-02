import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import type { RepoBranchSnapshot } from '../../../../../../shared/run-manifest'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../../shared/git-repo'
import { allocateRunPorts, applyFeatureEnvset } from './runtime/run-primitives'
import { restore } from './runtime/env-switcher/switch'
import type { BackupRecord } from './runtime/env-switcher/types'
import type { RunnerLog } from './runtime/runner-log'

type RestartPreparation =
  | { ok: true; portMap: Map<string, number> | undefined; backups: BackupRecord[] | null; repoBranchSnapshots: RepoBranchSnapshot[] }
  | { ok: false; stage: 'envset' | 'branches'; error: unknown }

export async function prepareRestartResources(options: {
  feature: FeatureConfig
  env: string | undefined
  runnerLog: RunnerLog
  envsetAppliedMessage: string
}): Promise<RestartPreparation> {
  const { feature, env, runnerLog, envsetAppliedMessage } = options
  const portMap = await allocateRunPorts(feature, env)
  let backups: BackupRecord[] | null = null
  if (env) {
    try {
      backups = applyFeatureEnvset(feature.featureDir, env, portMap)
      if (backups) runnerLog.info(envsetAppliedMessage)
    } catch (error) {
      // applyFeatureEnvset owns partial-write rollback before it returns backups.
      return { ok: false, stage: 'envset', error }
    }
  }
  try {
    await validateConfiguredRepoBranches(feature)
    const repoBranchSnapshots = await collectRepoBranchSnapshots(feature)
    // The adapter restores on constructor failure; attached run streams take
    // ownership of these same backups once construction succeeds.
    return { ok: true, portMap, backups, repoBranchSnapshots }
  } catch (error) {
    if (backups) restore(backups)
    return { ok: false, stage: 'branches', error }
  }
}
