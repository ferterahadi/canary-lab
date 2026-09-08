// The one grammar for "which requests does this atom touch": `"<METHOD> <path>"`.
//
// The method is an HTTP verb, `*` for any, or `WRITE` for anything that is not
// read-only (the default envelope duplicates and restarts on writes, since a
// replayed GET proves nothing). The path is a glob where `*` stays inside one
// segment and `**` crosses segments. Kept as a single string in the envelope
// because the repro fragment the human reads back is the same string.

export type MatchMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WRITE' | '*'

export interface RequestMatch {
  method: MatchMethod
  path: string
}

export type ParseRequestMatchResult =
  | { ok: true; match: RequestMatch }
  | { ok: false; reason: string }

const HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])
const SHAPE_REASON = 'match must be "<METHOD> <path>", e.g. "POST /reserve"'

export function parseRequestMatch(raw: string): ParseRequestMatchResult {
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 2 || parts[0] === '') return { ok: false, reason: SHAPE_REASON }
  const method = parts[0].toUpperCase()
  const path = parts[1]
  if (method !== '*' && method !== 'WRITE' && !HTTP_METHODS.has(method)) {
    return { ok: false, reason: `unknown method "${parts[0]}"; use an HTTP method, WRITE (any non-GET) or *` }
  }
  if (!path.startsWith('/')) return { ok: false, reason: 'path must start with "/"' }
  return { ok: true, match: { method: method as MatchMethod, path } }
}

export function requestMatches(match: RequestMatch, method: string, url: string): boolean {
  const m = method.toUpperCase()
  const methodOk = match.method === '*' || (match.method === 'WRITE' ? !READ_ONLY_METHODS.has(m) : match.method === m)
  if (!methodOk) return false
  const pathname = url.split('?')[0]
  return globToRegExp(match.path).test(pathname)
}

/** `/**` also matches the bare prefix (`/items/**` matches `/items`), so a
 *  default envelope written as `/**` covers the root path too. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `/**` → optionally a slash and anything after it
        if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?'
        else re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** The per-request predicate a shim keeps. Throws on an invalid match because
 *  `parseRobustnessEnvelope` has already refused that shape — reaching here with
 *  one means a caller skipped validation, and a silent never-matching atom would
 *  hide that. */
export function compileRequestMatch(raw: string): (method: string, url: string) => boolean {
  const parsed = parseRequestMatch(raw)
  if (!parsed.ok) throw new Error(`invalid request match "${raw}": ${parsed.reason}`)
  return (method, url) => requestMatches(parsed.match, method, url)
}
