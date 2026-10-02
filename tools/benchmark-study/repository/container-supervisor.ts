import { command } from '../files'
import { recoverCandidateResources, RecoveryOwnershipError, saveRecoveredState, saveRecovery,
  type ContainerRecoveryPlan, type ContainerRecoveryReceipt } from './container-recovery'

type Request = { operation: 'abort' } | { id: number; operation: 'finish' }
  | { id: number; operation: 'run'; args: string[]; timeoutMs?: number; log?: string }

export function superviseCandidate(plan: ContainerRecoveryPlan): void {
  let queue = Promise.resolve()
  let disconnected = false
  let finishing = false
  let ownershipFailure = false
  const interruption = new AbortController()
  const receipt: ContainerRecoveryReceipt = { status: 'armed', reason: 'normal', supervisorPid: process.pid,
    owner: plan.owner, volume: plan.volume, containers: plan.containers, errors: [] }
  const createsResource = (args: string[]): boolean => args[0] === 'create' || args[0] === 'start' ||
    args[0] === 'volume' && args[1] === 'create'
  const run = (args: string[], timeoutMs = 120_000, log?: string) => command(plan.executable, args,
    { cwd: plan.privateDir, env: plan.env, inheritEnv: false, timeoutMs, log, killGroupOnClose: true,
      signal: receipt.status === 'armed' && !createsResource(args) ? interruption.signal : undefined })
  const send = (message: unknown): void => {
    if (process.connected) process.send!(message, (error) => {
      // A parent may die after the connected check; disconnect drives recovery.
      if (error && process.connected) process.disconnect!()
    })
  }
  const cleanup = async (): Promise<void> => {
    receipt.status = 'recovering'
    saveRecovery(plan, receipt)
    try {
      await recoverCandidateResources(plan, run)
      receipt.status = 'cleaned'
      receipt.errors = []
      if (disconnected) saveRecoveredState(plan)
    } catch (error) {
      ownershipFailure = error instanceof RecoveryOwnershipError
      receipt.status = 'failed'
      receipt.errors = [String(error)]
    }
    saveRecovery(plan, receipt)
  }
  const cleaned = (): boolean => receipt.status === 'cleaned'
  process.on('message', (request: Request) => {
    if (request.operation === 'abort') { interruption.abort(); return }
    if (disconnected || finishing) return
    if (request.operation === 'finish') finishing = true
    queue = queue.then(async () => {
      if (request.operation === 'finish') {
        await cleanup()
        send({ id: request.id, receipt })
      } else {
        try { send({ id: request.id, result: await run(request.args, request.timeoutMs, request.log) }) }
        catch (error) { send({ id: request.id, error: String(error) }) }
      }
    })
  })
  process.once('disconnect', () => {
    disconnected = true
    interruption.abort()
    receipt.reason = finishing ? 'normal' : 'evaluator-disconnected'
    // Complete already accepted Docker commands before inspecting: otherwise a
    // create request can finish after the reaper has declared the name absent.
    queue.then(async () => {
      if (cleaned()) return
      do {
        await cleanup()
        if (!cleaned() && !ownershipFailure) await new Promise((resolve) => setTimeout(resolve, 5_000))
      } while (!cleaned() && !ownershipFailure)
    }).catch((error) => {
      receipt.status = 'failed'; receipt.errors = [String(error)]; saveRecovery(plan, receipt)
      process.exitCode = 1
    })
  })
  saveRecovery(plan, receipt)
  send({ ready: true })
}

if (process.argv[2]) superviseCandidate(JSON.parse(process.argv[2]))
