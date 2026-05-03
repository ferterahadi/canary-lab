import fs from 'fs'
import path from 'path'
import { parseDotenv } from '../../../../../shared/lib/dotenv-edit'

export interface TokenCtx {
  envName: string | undefined
  envsetsDir: string
}

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
  if (!ctx.envName || !value.includes('${')) return value
  return value.replace(TOKEN_RE, (full, slot, key) => {
    const map = loadSlot(ctx.envsetsDir, ctx.envName!, slot, cache)
    if (!map) return full
    const v = map.get(key)
    return v ?? full
  })
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
