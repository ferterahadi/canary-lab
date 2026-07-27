import path from 'path'
import type { FeatureConfig, PortSlot } from '../../../../../../../shared/launcher/types'
import { enabledForEnv, normalizeStartCommand, resolveHealthProbe, resolvePath } from '../../../../shared/launcher-startup'
import { buildRunPaths } from './run-paths'
import { type ServiceManifestEntry } from './manifest'
import { interpolateConfigTokens, makeTokenCache } from './launcher/interpolate'
import type { BuildServiceSpecsOptions, ServiceSpec } from './run-orchestrator-types'

export function resolvePortEnv(
  ports: PortSlot[] | undefined,
  portMap: Map<string, number> | undefined,
): { env: Record<string, string>; allocatedPorts: Record<string, number> } {
  const env: Record<string, string> = {}
  const allocatedPorts: Record<string, number> = {}
  for (const slot of ports ?? []) {
    const port = portMap?.get(slot.name)
    if (port == null) continue
    allocatedPorts[slot.name] = port
    if (slot.env) env[slot.env] = String(port)
  }
  return { env, allocatedPorts }
}

/** Gather the unique port slots a feature declares for the given env. The
 *  start flow allocates one free port per slot before constructing the
 *  orchestrator (buildServiceSpecs runs synchronously in the constructor). */
export function collectPortSlots(feature: FeatureConfig, env?: string): PortSlot[] {
  const slots = new Map<string, PortSlot>()
  for (const repo of feature.repos ?? []) {
    if (!enabledForEnv(repo.envs, env)) continue
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      if (!enabledForEnv(normalized.envs, env)) continue
      for (const slot of normalized.ports ?? []) {
        if (!slots.has(slot.name)) slots.set(slot.name, slot)
      }
    }
  }
  return [...slots.values()]
}

export function buildServiceSpecs(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
  opts: BuildServiceSpecsOptions = {},
): ServiceSpec[] {
  const out: ServiceSpec[] = []
  // ${slot.key} tokens in feature.config values resolve from the chosen env's
  // envset slot files at boot time, and the reserved ${port.<slot>} namespace
  // from the per-run port map. The cache shares parsed slot files across every
  // value in this build pass.
  const tokenCtx = {
    envName: env,
    envsetsDir: path.join(feature.featureDir, 'envsets'),
    ports: opts.portMap,
  }
  const tokenCache = makeTokenCache()
  const interp = <T,>(node: T): T => interpolateConfigTokens(node, tokenCtx, tokenCache)
  for (const repo of feature.repos ?? []) {
    if (!enabledForEnv(repo.envs, env)) continue
    const dir = opts.repoPathOverrides?.[repo.name] ?? resolvePath(repo.localPath)
    const commands = repo.startCommands ?? []
    for (let i = 0; i < commands.length; i++) {
      const normalized = normalizeStartCommand(commands[i], `${repo.name}-cmd-${i + 1}`)
      if (!enabledForEnv(normalized.envs, env)) continue
      const safeName = normalized.name!.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      const probe = resolveHealthProbe(normalized.healthCheck, env)
      const { env: portEnv, allocatedPorts } = resolvePortEnv(normalized.ports, opts.portMap)
      out.push({
        repoName: repo.name,
        name: normalized.name!,
        safeName,
        command: interp(normalized.command),
        cwd: dir,
        healthProbe: probe ? interp(probe) : undefined,
        ...(Object.keys(portEnv).length > 0 ? { env: portEnv } : {}),
        ...(Object.keys(allocatedPorts).length > 0 ? { allocatedPorts } : {}),
        // Service log path is implied by runDir; consumers can derive via buildRunPaths.
      })
    }
  }
  return out
}

/**
 * Manifest service entries for a *queued* run — built from the feature config
 * before any process spawns, so the queued run's Overview lists the services
 * that will boot once it leaves the queue (instead of "No services configured").
 * Ports aren't allocated until promotion, so `allocatedPorts` and the
 * port-templated `healthUrl` are intentionally omitted; status is 'queued'.
 * Promotion later overwrites this with the real running manifest.
 */
export function buildQueuedServiceEntries(
  feature: FeatureConfig,
  runDir: string,
  env?: string,
): ServiceManifestEntry[] {
  const paths = buildRunPaths(runDir)
  return buildServiceSpecs(feature, runDir, env).map((s) => ({
    repoName: s.repoName,
    name: s.name,
    safeName: s.safeName,
    command: s.command,
    cwd: s.cwd,
    logPath: paths.serviceLog(s.safeName),
    status: 'queued',
  }))
}
