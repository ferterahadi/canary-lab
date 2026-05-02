import http from 'http'
import https from 'https'
import net from 'net'
import os from 'os'
import type { HealthCheck, HealthProbe, HttpProbe, LegacyHealthProbe, StartCommand, TcpProbe } from './types'

export interface StartTab {
  dir: string
  command: string
  name: string
}

export function resolvePath(p: string): string {
  return p.startsWith('~/') ? p.replace('~', os.homedir()) : p
}

// Whether a repo or startCommand with an `envs` whitelist is active in the
// selected env. Absent whitelist = active everywhere; absent selected env =
// no filtering (legacy callers that don't pass env).
export function enabledForEnv(envs: string[] | undefined, selected: string | undefined): boolean {
  return !selected || !envs || envs.includes(selected)
}

export function normalizeStartCommand(
  command: string | StartCommand,
  fallbackName: string,
): StartCommand {
  if (typeof command === 'string') {
    return {
      command,
      name: fallbackName,
    }
  }

  return {
    ...command,
    name: command.name ?? fallbackName,
  }
}

// A "probe shape" is either the new tagged form (`{ http }` / `{ tcp }`) or
// the legacy flat form (`{ url, timeoutMs }`). Anything else with named keys
// is an env→probe map.
function isProbeShape(x: HealthCheck): x is HealthProbe | LegacyHealthProbe {
  if (x == null || typeof x !== 'object') return false
  return 'http' in x || 'tcp' in x || 'url' in x
}

/**
 * Coerce the legacy bare-`url` probe shape to the new tagged
 * `{ http: { url, timeoutMs } }` shape. The new tagged shape passes
 * through unchanged. Throws on a probe object that has neither a
 * transport key nor a top-level `url`.
 */
export function coerceProbe(raw: HealthProbe | LegacyHealthProbe): HealthProbe {
  if ('http' in raw || 'tcp' in raw) return raw as HealthProbe
  if ('url' in raw && typeof raw.url === 'string') {
    return { http: { url: raw.url, timeoutMs: raw.timeoutMs } }
  }
  throw new Error('healthCheck probe must declare one transport: http or tcp')
}

/**
 * Resolve which `HealthProbe` applies for the given env. Order:
 *   1. Tagged or legacy flat shape → coerce + return.
 *   2. Env→probe map with exact match for `env` → coerce + return.
 *   3. Env→probe map with a `default` key → coerce + return.
 *   4. Otherwise → null (caller should warn + skip waiting).
 */
export function resolveHealthProbe(
  check: HealthCheck | undefined,
  env: string | undefined,
): HealthProbe | null {
  if (!check) return null
  if (Object.keys(check).length === 0) return null
  if (isProbeShape(check)) return coerceProbe(check)
  const map = check as Record<string, HealthProbe | LegacyHealthProbe>
  if (env && env in map) return coerceProbe(map[env])
  if ('default' in map) return coerceProbe(map.default)
  return null
}

/**
 * Validate a `HealthCheck` config at load time. Throws a descriptive error
 * on:
 *   - a probe with both `http` and `tcp` keys,
 *   - an empty env→probe map,
 *   - a malformed `http` (missing `url`) or `tcp` (missing/NaN `port`).
 *
 * `ctx` is folded into the error message so the user can locate the offender.
 */
export function validateHealthCheck(
  check: HealthCheck | undefined,
  ctx: { feature: string; command: string },
): void {
  if (check == null) return
  if (typeof check !== 'object') {
    throw makeProbeError(ctx, undefined, 'healthCheck must be an object')
  }
  if (Object.keys(check).length === 0) {
    throw makeProbeError(ctx, undefined, 'healthCheck is empty; remove it or declare a probe')
  }
  if (isProbeShape(check)) {
    validateProbe(check, ctx, undefined)
    return
  }
  const map = check as Record<string, HealthProbe | LegacyHealthProbe>
  for (const [envName, probe] of Object.entries(map)) {
    if (!probe || typeof probe !== 'object') {
      throw makeProbeError(ctx, envName, 'env entry must be an object')
    }
    validateProbe(probe, ctx, envName)
  }
}

function validateProbe(
  raw: HealthProbe | LegacyHealthProbe,
  ctx: { feature: string; command: string },
  envName: string | undefined,
): void {
  const hasHttp = 'http' in raw
  const hasTcp = 'tcp' in raw
  const hasLegacyUrl = !hasHttp && !hasTcp && 'url' in raw

  if (hasHttp && hasTcp) {
    throw makeProbeError(ctx, envName, 'declare exactly one transport — got both http and tcp')
  }
  if (!hasHttp && !hasTcp && !hasLegacyUrl) {
    throw makeProbeError(ctx, envName, 'declare one transport: http or tcp')
  }

  if (hasHttp) {
    const p = (raw as { http: HttpProbe }).http
    if (!p || typeof p !== 'object' || typeof p.url !== 'string' || p.url.length === 0) {
      throw makeProbeError(ctx, envName, 'http.url must be a non-empty string')
    }
  } else if (hasTcp) {
    const p = (raw as { tcp: TcpProbe }).tcp
    if (!p || typeof p !== 'object' || typeof p.port !== 'number' || !Number.isFinite(p.port) || p.port <= 0) {
      throw makeProbeError(ctx, envName, 'tcp.port must be a positive number')
    }
  } else {
    // Legacy bare-url shape — accepted for back-compat. Sanity-check the url.
    const p = raw as LegacyHealthProbe
    if (typeof p.url !== 'string' || p.url.length === 0) {
      throw makeProbeError(ctx, envName, 'legacy healthCheck.url must be a non-empty string')
    }
  }
}

function makeProbeError(
  ctx: { feature: string; command: string },
  envName: string | undefined,
  reason: string,
): Error {
  const where = envName ? ` → env "${envName}"` : ''
  return new Error(
    `Feature "${ctx.feature}" → command "${ctx.command}"${where}: ${reason}.\n`
    + `healthCheck must declare exactly one transport. Choose one of:\n`
    + `  http: { url: 'http://localhost:3000', timeoutMs?: 1500 }\n`
    + `  tcp:  { port: 3000, host?: '127.0.0.1', timeoutMs?: 1500 }`,
  )
}

/**
 * Returns true when a local TCP port is in LISTEN state. Used by readiness
 * probes that don't have a meaningful HTTP endpoint yet (e.g. raw TCP services
 * or HTTP servers that 404 the root).
 */
export async function isTcpListening(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 1500,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    const t = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => { clearTimeout(t); finish(true) })
    socket.once('error', () => { clearTimeout(t); finish(false) })
  })
}

export async function isHealthy(url: string, timeoutMs = 1500): Promise<boolean> {
  const client = url.startsWith('https://') ? https : http

  return await new Promise((resolve) => {
    const req = client.get(
      url,
      { timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) < 500)
      },
    )

    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    req.on('error', () => resolve(false))
  })
}

