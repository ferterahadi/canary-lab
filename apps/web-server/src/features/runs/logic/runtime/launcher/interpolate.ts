import fs from 'fs'
import path from 'path'
import { parseDotenv } from '../../../../../../../../shared/lib/dotenv-edit'

export interface TokenCtx {
  envName: string | undefined
  envsetsDir: string
  /** Per-run allocated ports keyed by slot name. Resolves the reserved
   *  `${port.<slot>}` namespace. Independent of envName/envsets. */
  ports?: Map<string, number>
}

/** Reserved token namespace for per-run allocated ports (`${port.api}`). */
const PORT_SLOT = 'port'

const TOKEN_RE = /\$\{([a-zA-Z0-9._-]+)\.([a-zA-Z0-9_-]+)\}/g

// Cache parsed slot files for the lifetime of one resolution pass. Callers
// build a fresh cache via makeCache() per buildServiceSpecs invocation.
type Cache = Map<string, Map<string, string>>

function loadSlot(envsetsDir: string, env: string, slot: string, cache: Cache): Map<string, string> | null {
  const cacheKey = `${env}/${slot}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const file = path.join(envsetsDir, env, slot)
  if (!fs.existsSync(file)) {
    cache.set(cacheKey, new Map())
    return null
  }
  const parsed = parseDotenv(fs.readFileSync(file, 'utf-8'))
  const map = new Map(parsed.entries.map((e) => [e.key, e.value]))
  cache.set(cacheKey, map)
  return map
}

export function makeTokenCache(): Cache {
  return new Map()
}

export function interpolateFeatureTokens(
  value: string,
  ctx: TokenCtx,
  cache: Cache = makeTokenCache(),
): string {
  if (!value.includes('${')) return value
  return value.replace(TOKEN_RE, (full, slot, key) => {
    // Reserved per-run port namespace — independent of env/envsets.
    if (slot === PORT_SLOT) {
      const port = ctx.ports?.get(key)
      return port == null ? full : String(port)
    }
    // Envset-backed tokens require a selected env to resolve.
    if (!ctx.envName) return full
    const map = loadSlot(ctx.envsetsDir, ctx.envName, slot, cache)
    if (!map) return full
    const v = map.get(key)
    return v ?? full
  })
}

/**
 * Resolve ONLY the reserved `${port.<slot>}` namespace in arbitrary text — used
 * when applying envset files for a run, so a multi-service feature's
 * inter-service URLs and config-file listen ports follow the run's allocated
 * ports. Every other `${...}` token is left literal (envName is undefined, so
 * envset-slot tokens never resolve here).
 */
export function resolvePortTokens(content: string, ports: Map<string, number>): string {
  return interpolateFeatureTokens(content, { envName: undefined, envsetsDir: '', ports })
}

export function interpolateConfigTokens<T>(
  node: T,
  ctx: TokenCtx,
  cache: Cache = makeTokenCache(),
): T {
  if (typeof node === 'string') {
    return interpolateFeatureTokens(node, ctx, cache) as unknown as T
  }
  if (Array.isArray(node)) {
    return node.map((child) => interpolateConfigTokens(child, ctx, cache)) as unknown as T
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateConfigTokens(v, ctx, cache)
    }
    return out as unknown as T
  }
  return node
}
