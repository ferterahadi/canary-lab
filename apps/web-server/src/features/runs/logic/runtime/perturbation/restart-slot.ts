import { spawnService, waitForServiceReady } from '../run-service-boot'
import type { RunContext } from '../run-context'
import { killTree, scheduleSigkillFallback } from '../run-spawn'

// The restart atom's runtime half (D15): recycle the ONE service that owns a
// port slot, mid-run, while the shim holds the triggering request. Composes the
// boot primitives the run already uses — `spawnService` + `waitForServiceReady`
// — rather than `RunOrchestrator.restart`, which plans by changed files and
// writes heal-lifecycle records this has no business emitting.

export interface RestartSlotOptions {
  /** How long to wait for the old process to exit before spawning over it. A
   *  service that ignores SIGTERM gets the shared SIGKILL fallback at 2 s. */
  exitWaitMs?: number
}

export async function restartSlotService(ctx: RunContext, slot: string, opts: RestartSlotOptions = {}): Promise<void> {
  const svc = ctx.services.find((s) => s.allocatedPorts?.[slot] !== undefined)
  if (!svc) throw new Error(`no service in this run declares port slot "${slot}"`)

  const pty = ctx.servicePtys.get(svc.name)
  if (pty) {
    killTree(pty, 'SIGTERM')
    scheduleSigkillFallback(pty)
    // Spawning before the old process is really gone races it for the port.
    await Promise.race([
      new Promise<void>((resolve) => { pty.onExit(() => resolve()) }),
      ctx.delay(opts.exitWaitMs ?? 5000),
    ])
    ctx.servicePtys.delete(svc.name)
  }

  // Same fresh-attempt reset as `ensureServicesRunning`: a failure recorded
  // below is THIS restart's, so the caller can tell the shim what happened.
  ctx.bootFailure = undefined
  ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'starting')
  spawnService(ctx, svc)
  await waitForServiceReady(ctx, svc)
  const failure = recordedBootFailure(ctx)
  if (failure) throw new Error(failure.detail)
}

// Read through a call so TypeScript does not carry the `= undefined` narrowing
// above across the await; the probe writes this field from another frame.
function recordedBootFailure(ctx: RunContext): RunContext['bootFailure'] {
  return ctx.bootFailure
}
