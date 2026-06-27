// Side-effect-free helpers for the "a newer canary-lab is published" check.
// Kept separate from `upgrade-check.ts` (which compares the installed package
// against the project's scaffold STAMP — a different drift). This module is
// about the npm REGISTRY: is the latest published version newer than the one
// the running process was started with?

export interface Semver {
  major: number
  minor: number
  patch: number
}

/**
 * Parse a `major.minor.patch` string. Trailing prerelease/build metadata
 * (`-rc.1`, `+sha`) is ignored — we only gate on the release triple. Returns
 * null when the core numbers aren't parseable.
 */
export function parseSemver(version: string | null | undefined): Semver | null {
  if (typeof version !== 'string') return null
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0]
  const parts = core.split('.')
  if (parts.length < 3) return null
  const [major, minor, patch] = parts.map((p) => Number(p))
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null
  return { major, minor, patch }
}

/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable versions sort as equal (0). */
export function compareSemver(a: string | null, b: string | null): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return 0
}

/** True when `latest` is a strictly newer release than `installed`. */
export function isOutdated(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false
  return compareSemver(installed, latest) < 0
}

export interface FetchLatestOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Abort the request after this many ms. */
  timeoutMs?: number
}

/**
 * Fetch the `latest` published version for `packageName` from the npm registry.
 * Fail-silent: any network error, non-200, malformed body, or timeout resolves
 * to `null` so a registry hiccup never blocks startup or surfaces an error.
 */
export async function fetchLatestVersion(
  packageName: string,
  opts: FetchLatestOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) return null
  const timeoutMs = opts.timeoutMs ?? 2000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    )
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
