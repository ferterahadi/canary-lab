import path from 'path'
import type { FeatureConfig } from '../../../../../../../../shared/launcher/types'
import { collectPortSlots, buildServiceSpecs } from '../orchestrator'
import { allocatePorts, releasePorts } from '../port-allocator'
import { bootAndProbe, fileTee, type BootProbeResult } from '../boot-probe'
import type { PtyFactory } from '../pty-spawner'
import type { PortifyBootInstance, PortifyVerification } from './types'

// Proof that a feature's ports are injectable: boot the whole stack TWICE
// CONCURRENTLY on two disjoint port maps and require both to come up healthy.
//
// Correctness lynchpin: ports are injected via each service's PROCESS ENV
// (buildServiceSpecs' resolvePortEnv) — never an on-disk `.env`. Both instances
// share one worktree checkout, so a shared config file would collide; per-
// process env injection is exactly what port-ification enables. We therefore do
// NOT apply any envset to disk here.

export interface VerifyDeps {
  ptyFactory: PtyFactory
  healthCheck?: (url: string, timeoutMs?: number) => Promise<boolean>
  healthPollIntervalMs?: number
  healthDeadlineMs?: number
  /** Where to tee each instance's service logs. */
  verifyLogDir: string
  /** Small stagger between the two boots to avoid npm/tsx cold-cache thrash. */
  staggerMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function verifyDoubleBoot(
  feature: FeatureConfig,
  env: string | undefined,
  /** Per-repo worktree localPath overrides so source boots from the worktree. */
  repoPathOverrides: Record<string, string>,
  deps: VerifyDeps,
): Promise<PortifyVerification> {
  const slots = collectPortSlots(feature, env)
  if (slots.length === 0) {
    return {
      ok: false,
      instances: [],
      failureDetail:
        'No port slots are declared after the edit. Each service that listens must declare `ports: [{ name, env }]` on its startCommand so a port can be injected per run.',
    }
  }

  const slotsWithoutEnv = slots.filter((s) => !s.env)
  if (slotsWithoutEnv.length > 0) {
    return {
      ok: false,
      instances: [],
      failureDetail:
        `These port slots declare no \`env\` field, so a port can't be injected per-process: ` +
        `${slotsWithoutEnv.map((s) => s.name).join(', ')}. Add an env var the service reads (e.g. PORT).`,
    }
  }

  const portMapA = await allocatePorts(slots)
  const portMapB = await allocatePorts(slots)
  const allPorts = [...portMapA.values(), ...portMapB.values()]

  const specsA = buildServiceSpecs(feature, deps.verifyLogDir, env, { portMap: portMapA, repoPathOverrides })
  const specsB = buildServiceSpecs(feature, deps.verifyLogDir, env, { portMap: portMapB, repoPathOverrides })

  const bootOpts = {
    ptyFactory: deps.ptyFactory,
    healthCheck: deps.healthCheck,
    healthPollIntervalMs: deps.healthPollIntervalMs,
    healthDeadlineMs: deps.healthDeadlineMs,
  }

  let resA: BootProbeResult | undefined
  let resB: BootProbeResult | undefined
  try {
    ;[resA, resB] = await Promise.all([
      bootAndProbe({
        ...bootOpts,
        specs: specsA,
        onOutput: fileTee(deps.verifyLogDir, 'a'),
        fullLogPathFor: (safeName) => path.join(deps.verifyLogDir, `a-${safeName}.log`),
      }),
      (async () => {
        await delay(deps.staggerMs ?? 250)
        return bootAndProbe({
          ...bootOpts,
          specs: specsB,
          onOutput: fileTee(deps.verifyLogDir, 'b'),
          fullLogPathFor: (safeName) => path.join(deps.verifyLogDir, `b-${safeName}.log`),
        })
      })(),
    ])
  } finally {
    try { resA?.teardown() } catch { /* ignore */ }
    try { resB?.teardown() } catch { /* ignore */ }
    releasePorts(allPorts)
  }

  // resA/resB are always assigned by the time we get here (bootAndProbe never
  // rejects; the only way past the try is a normal completion). The `?.` in the
  // finally guards the throw-before-assignment case.
  const instances: PortifyBootInstance[] = [
    instanceFrom(portMapA, resA!),
    instanceFrom(portMapB, resB!),
  ]
  const ok = instances.every((i) => i.ok)
  const failureDetail = ok
    ? undefined
    : instances
        // A failed instance always carries failedService + detail (set by
        // bootAndProbe), so no fallback is needed.
        .filter((i) => !i.ok)
        .map((i) => `boot on ports {${fmtPorts(i.ports)}} failed: ${i.failedService} — ${i.detail}`)
        .join('\n')

  // If EVERY failed boot died on an unreachable dependency, this is an
  // environment problem, not a port one — no point retrying the rewrite.
  const failedBoots = [resA!, resB!].filter((r) => !r.ok)
  const notPortFixable =
    !ok && failedBoots.length > 0 && failedBoots.every((r) => !r.ok && r.kind === 'dependency')

  return { ok, instances, failureDetail, notPortFixable }
}

function instanceFrom(portMap: Map<string, number>, res: BootProbeResult): PortifyBootInstance {
  const ports = Object.fromEntries(portMap)
  if (res.ok) return { ports, ok: true }
  return { ports, ok: false, failedService: res.failedService, detail: res.detail }
}

function fmtPorts(ports: Record<string, number>): string {
  return Object.entries(ports).map(([k, v]) => `${k}:${v}`).join(', ')
}
