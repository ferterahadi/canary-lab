import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { enabledRepoCommands } from '../../../../shared/launcher-startup'

// Preflight check answering "are this feature's apps configured for dynamic,
// injectable ports?" — the precondition for booting the same feature more than
// once concurrently (benchmark arms, parallel runs) without an EADDRINUSE clash.
//
// A start command is "configured" when it declares one or more port slots
// (`ports: [{ name, env }]`). A feature with no bootable start commands has
// nothing to clash, so it is trivially configured. The check is intentionally
// shallow: it trusts a declared slot as honored. Deep verification (actually
// booting twice on different ports) happens once, inside the port-ification
// workflow — not on every benchmark.

export interface PreflightCommand {
  name: string
  declaredPorts: { name: string; env?: string }[]
}

export interface PreflightRepo {
  name: string
  commands: PreflightCommand[]
}

export interface PortPreflight {
  portsConfigured: boolean
  repos: PreflightRepo[]
}

export function computePortPreflight(feature: FeatureConfig, env?: string): PortPreflight {
  const repos: PreflightRepo[] = []
  let bootableCommands = 0
  let declaredSlots = 0

  for (const { repo, commands } of enabledRepoCommands(feature, env)) {
    const outCommands: PreflightCommand[] = []
    for (const normalized of commands) {
      bootableCommands += 1
      const declaredPorts = (normalized.ports ?? []).map((p) => ({
        name: p.name,
        ...(p.env ? { env: p.env } : {}),
      }))
      declaredSlots += declaredPorts.length
      outCommands.push({ name: normalized.name, declaredPorts })
    }
    if (outCommands.length > 0) repos.push({ name: repo.name, commands: outCommands })
  }

  // Not configured iff there is something to boot but nothing declares a slot.
  const portsConfigured = bootableCommands === 0 || declaredSlots > 0
  return { portsConfigured, repos }
}
