import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { collectPortSlots, buildServiceSpecs } from '../../../runs/logic/runtime/orchestrator'
import { allocatePorts, releasePorts } from '../../../runs/logic/runtime/port-allocator'
import { bootAndProbe, fileTee, type BootProbeResult } from '../../../runs/logic/runtime/boot-probe'
import type { PtyFactory } from '../../../runs/logic/runtime/pty-spawner'
import type { PortifyBootInstance, PortifyVerification } from './types'

// Proof that a feature's ports are injectable: boot the whole stack TWICE
// CONCURRENTLY on two disjoint port maps and require both to come up healthy.
//
// Correctness lynchpin: PORTS are injected via each service's PROCESS ENV
// (buildServiceSpecs' resolvePortEnv) — never an on-disk file. Both instances
// share one worktree checkout, so a file could only ever carry ONE port map.
// NON-port envset content (datasource hosts, API keys) is identical for both
// instances, so the caller (the runner's verify dep) hydrates it into the
// worktree for the boot window via hydrateEnvsetIntoWorktrees — without it the
// boots run the checked-in config the real-path envset apply normally
// overwrites — leaving any `${port.*}` tokens in those files verbatim. Only
// port-dependent wiring must stay per-process; this function itself still
// touches no disk.

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

  if (ok || notPortFixable) return { ok, instances, failureDetail, notPortFixable }

  // Differential triage: the double-boot conflates "can this feature boot at
  // all?" with "do two concurrent boots collide?". One extra SOLO boot on its
  // own fresh ports separates them, so the retry prompt sends the agent at the
  // real defect instead of burning attempts port-hunting a baseline failure
  // (e.g. a boot-time migration validating against drifted shared-DB state).
  // Runs only on the failure path — a passing verify costs nothing extra.
  // NOT a hard stop either way: an agent CAN fix an app-code baseline blocker
  // (a Flyway validation relax did exactly that), so this classifies blame
  // rather than killing the workflow.
  const portMapC = await allocatePorts(slots)
  const specsC = buildServiceSpecs(feature, deps.verifyLogDir, env, { portMap: portMapC, repoPathOverrides })
  let resC: BootProbeResult | undefined
  try {
    resC = await bootAndProbe({
      ...bootOpts,
      specs: specsC,
      onOutput: fileTee(deps.verifyLogDir, 'baseline'),
      fullLogPathFor: (safeName) => path.join(deps.verifyLogDir, `baseline-${safeName}.log`),
    })
  } finally {
    try { resC?.teardown() } catch { /* ignore */ }
    releasePorts([...portMapC.values()])
  }
  const failureClass = resC!.ok ? 'concurrency-failure' : 'baseline-boot-failed'
  const triage =
    failureClass === 'baseline-boot-failed'
      ? `BASELINE CHECK: a SINGLE boot on its own ports ALSO fails — this failure is NOT caused by concurrency or port injection. Fix the boot blocker itself if it lives in the app code, or report it as not port-fixable if it is environmental. Solo-boot failure: ${resC!.ok ? '' : `${resC!.failedService} — ${resC!.detail}`}`
      : 'BASELINE CHECK: a single boot on its own ports PASSES — the failure only appears when TWO instances boot concurrently. Look for per-boot state that is still shared: a build/cache dir both boots write, a port one of them still hardcodes, on-disk files both mutate.'
  return {
    ok,
    instances,
    failureDetail: failureDetail ? `${triage}\n\n${failureDetail}` : triage,
    notPortFixable,
    failureClass,
  }
}

function instanceFrom(portMap: Map<string, number>, res: BootProbeResult): PortifyBootInstance {
  const ports = Object.fromEntries(portMap)
  if (res.ok) return { ports, ok: true }
  return { ports, ok: false, failedService: res.failedService, detail: res.detail }
}

function fmtPorts(ports: Record<string, number>): string {
  return Object.entries(ports).map(([k, v]) => `${k}:${v}`).join(', ')
}
