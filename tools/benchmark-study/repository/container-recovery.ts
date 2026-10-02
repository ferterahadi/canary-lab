import fs from 'node:fs'
import path from 'node:path'
import { json, type CommandResult } from '../files'

export const recoveryLabel = 'canary.benchmark.owner'
export interface ContainerRecoveryPlan {
  privateDir: string
  env: NodeJS.ProcessEnv
  executable: string
  owner: string
  volume: string
  containers: string[]
}
export interface ContainerRecoveryReceipt {
  status: 'armed' | 'recovering' | 'cleaned' | 'failed'
  reason: 'normal' | 'evaluator-disconnected'
  supervisorPid: number
  owner: string
  volume: string
  containers: string[]
  errors: string[]
}
export type DockerRun = (args: string[], timeoutMs?: number, log?: string) => Promise<CommandResult>
interface DockerResource {
  Id: string
  Config?: { Labels?: Record<string, string> }
  Labels?: Record<string, string>
  State: { Running: boolean; Pid: number }
}
export class RecoveryOwnershipError extends Error {}

export function saveRecovery(plan: ContainerRecoveryPlan, receipt: ContainerRecoveryReceipt): void {
  json(path.join(plan.privateDir, 'container-recovery.json'), receipt)
}

// Names are allocated before any Docker request, and labels prove ownership even
// when the evaluator dies between daemon-side creation and saving its state.
export async function recoverCandidateResources(plan: ContainerRecoveryPlan, run: DockerRun): Promise<void> {
  const checked = async (args: string[]): Promise<string> => {
    const result = await run(args, 15_000)
    if (result.code !== 0 || result.timedOut) throw new Error(`Recovery Docker ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const inspect = async (kind: 'container' | 'volume', name: string): Promise<DockerResource | undefined> => {
    const result = await run([kind, 'inspect', name], 15_000)
    if (result.code === 0 && !result.timedOut) {
      const records = JSON.parse(result.stdout) as DockerResource[]
      if (!Array.isArray(records) || records.length !== 1 || !records[0] ||
          kind === 'container' && (typeof records[0].Id !== 'string' ||
            typeof records[0].State?.Running !== 'boolean' || !Number.isInteger(records[0].State?.Pid))) {
        throw new Error(`Recovery received malformed ${kind} inspection: ${name}`)
      }
      return records[0]
    }
    if (result.code === 1 && !result.timedOut && /no such (container|object|volume)(:|\s*$)/i.test(result.stderr)) return undefined
    throw new Error(`Recovery could not inspect ${kind} ${name}: ${result.stderr}`)
  }
  for (const name of [...plan.containers].reverse()) {
    const container = await inspect('container', name)
    if (!container) continue
    if (container.Config?.Labels?.[recoveryLabel] !== plan.owner) throw new RecoveryOwnershipError(`Recovery refused unowned container: ${name}`)
    if (container.State.Running) await checked(['kill', container.Id])
    const stopped = await inspect('container', name)
    if (stopped && (stopped.State.Running || stopped.State.Pid !== 0)) throw new Error(`Recovery container did not stop: ${name}`)
    if (stopped) await checked(['rm', container.Id])
    if (await inspect('container', name)) throw new Error(`Recovery container still exists: ${name}`)
  }
  const volume = await inspect('volume', plan.volume)
  if (volume) {
    if (volume.Labels?.[recoveryLabel] !== plan.owner) throw new RecoveryOwnershipError(`Recovery refused unowned volume: ${plan.volume}`)
    await checked(['volume', 'rm', plan.volume])
    if (await inspect('volume', plan.volume)) throw new Error(`Recovery volume still exists: ${plan.volume}`)
  }
}

export function saveRecoveredState(plan: ContainerRecoveryPlan): void {
  const file = path.join(plan.privateDir, 'container-state.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  state.volumeRemoved = true
  for (const container of state.containers) { container.stopped = true; container.removed = true }
  json(file, state)
}
