import type { RobustnessEnvelope } from '../../../../../../../../shared/robustness/types'

/** What a perturbed run boots under: the envelope and one allocated shim port
 *  per declared slot. Services and their health probes keep `portMap`; this is
 *  what Playwright and the envsets are pointed at instead (D14). */
export interface RunPerturbation {
  envelope: RobustnessEnvelope
  shimPorts: Map<string, number>
}

/** The ports CLIENTS of the services use — the shims when perturbing, the real
 *  ports otherwise. One home so `CANARY_PORT_<slot>` and `${port.<slot>}` can
 *  never disagree about which side of the shim a test talks to. */
export function clientPortMap(ctx: { portMap?: Map<string, number>; perturbation?: RunPerturbation }): Map<string, number> | undefined {
  return ctx.perturbation?.shimPorts ?? ctx.portMap
}
