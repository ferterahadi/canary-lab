import type { RobustnessEnvelope } from '../../../../../../../../shared/robustness/types'
import { findFreePort } from '../port-allocator'
import type { RunContext } from '../run-context'
import { startProxyShim } from './proxy-shim'
import { restartSlotService } from './restart-slot'
import type { RunPerturbation } from './client-ports'

export { clientPortMap, type RunPerturbation } from './client-ports'

// Booting a run under a perturbation (D14–D16). The launcher allocates the shim
// ports BEFORE the envset is applied — `${port.<slot>}` must already point at
// the shim when the files are written — and the orchestrator starts the shims
// only after every service is healthy, so the first request a test makes is
// the first request perturbed.

/** One free port per declared slot, reserved through the same allocator as the
 *  real ports so a concurrent run can never receive one of them. A feature with
 *  no slots has nothing to front — the Portify bar — and is refused as a 400
 *  so the route can say so rather than booting an unperturbed run that would
 *  read as "the app survived". */
export async function allocatePerturbationPorts(
  envelope: RobustnessEnvelope | undefined,
  portMap: Map<string, number> | undefined,
): Promise<RunPerturbation | undefined> {
  if (!envelope) return undefined
  if (!portMap || portMap.size === 0) {
    throw Object.assign(
      new Error('this suite declares no port slots, so nothing can be fronted by a shim — robustness needs declared slots (run Portify or declare `ports` on each start command)'),
      { statusCode: 400 },
    )
  }
  const shimPorts = new Map<string, number>()
  for (const slot of portMap.keys()) shimPorts.set(slot, await findFreePort())
  return { envelope, shimPorts }
}

export async function startPerturbationShims(ctx: RunContext): Promise<void> {
  const perturbation = ctx.perturbation
  if (!perturbation) return
  const { envelope } = perturbation
  for (const [slot, shimPort] of perturbation.shimPorts) {
    const restart = envelope.restart?.find((r) => r.slot === slot)
    ctx.perturbationShims.push(await startProxyShim({
      slot,
      // The launcher built `shimPorts` from `portMap`'s own keys, so every slot
      // here has a real port; the fallback would only ever be reached by a
      // caller that assembled the two maps by hand.
      upstreamPort: ctx.portMap!.get(slot)!,
      listenPort: shimPort,
      latency: envelope.latency,
      duplicate: envelope.duplicate,
      ...(restart ? { restart: { afterNth: restart.afterNth, match: restart.match, perform: () => restartSlotService(ctx, slot) } } : {}),
    }))
  }
}

/** Before every Playwright pass: the first run and each heal-cycle rerun must
 *  meet the same perturbation, or a rerun after a repair passes because the
 *  restart already happened, not because the app now survives it. */
export function resetPerturbationShims(ctx: RunContext): void {
  for (const shim of ctx.perturbationShims) shim.reset()
}

export async function stopPerturbationShims(ctx: RunContext): Promise<void> {
  const shims = ctx.perturbationShims.splice(0)
  await Promise.all(shims.map((s) => s.close()))
}
