import fs from 'fs'
import path from 'path'

// Per-failure capture target for `@playwright/mcp` artifacts.
//
// Approach A (locked in the slice plan): the heal agent's MCP config sets
// `--output-dir <path>` for the Playwright MCP server, scoped to a single
// failure when only one test failed, or to a per-run dir with attribution
// when multiple failed.
//
// This module is pure file/fs — no subprocesses, fully unit-testable.

export const MAX_FILES_PER_FAILURE = 10
export const MAX_BYTES_PER_FAILURE = 5 * 1024 * 1024

export interface ArtifactInfo {
  name: string
  path: string  // absolute path
  bytes: number
  mtimeMs: number
}

// Resolve where MCP should write artifacts for a heal cycle. If exactly one
// failure exists, scope the output dir to that failure's slug so attribution
// is implicit. Otherwise use a shared per-run dir; the caller is responsible
// for writing attribution alongside.
export function resolveMcpOutputDir(opts: {
  runDir: string
  failedSlugs: readonly string[]
}): { dir: string; perFailure: boolean; slug?: string } {
  if (opts.failedSlugs.length === 1) {
    const slug = opts.failedSlugs[0]
    return {
      dir: path.join(opts.runDir, 'failed', slug, 'playwright-mcp'),
      perFailure: true,
      slug,
    }
  }
  return {
    dir: path.join(opts.runDir, 'playwright-mcp'),
    perFailure: false,
  }
}

// Ensure the target dir exists before the agent spawns. Returns the dir for
// chaining.
export function ensureMcpOutputDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// List artifacts in a directory, sorted oldest-first by mtime. Pure read.
export function listArtifacts(dir: string): ArtifactInfo[] {
  if (!fs.existsSync(dir)) return []
  const out: ArtifactInfo[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('_')) continue // skip _attribution.json
    const full = path.join(dir, entry.name)
    try {
      const st = fs.statSync(full)
      out.push({
        name: entry.name,
        path: full,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      })
    } catch {
      /* ignore disappearing files */
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

// Cap the dir to ≤ MAX_FILES_PER_FAILURE files AND ≤ MAX_BYTES_PER_FAILURE
// total. Whichever cap is hit first triggers oldest-first eviction. Pure
// function returns the list of evicted paths so callers can log; the dir is
// mutated.
export function capArtifacts(
  dir: string,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): { kept: ArtifactInfo[]; evicted: string[] } {
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_FAILURE
  const maxBytes = opts.maxBytes ?? MAX_BYTES_PER_FAILURE
  const all = listArtifacts(dir)
  const evicted: string[] = []

  // 1) Drop oldest until count <= maxFiles.
  let head = 0
  while (all.length - head > maxFiles) {
    const victim = all[head++]
    try { fs.unlinkSync(victim.path) } catch { /* ignore */ }
    evicted.push(victim.path)
  }

  // 2) Drop oldest until total bytes <= maxBytes.
  let total = 0
  for (let i = head; i < all.length; i++) total += all[i].bytes
  while (total > maxBytes && head < all.length) {
    const victim = all[head++]
    total -= victim.bytes
    try { fs.unlinkSync(victim.path) } catch { /* ignore */ }
    evicted.push(victim.path)
  }

  return { kept: all.slice(head), evicted }
}

// Build the bullet to splice into heal-index.md under a failure entry. Pure
// string formatting. Caller passes the list of artifacts (already capped).
export function renderHealIndexBullet(args: {
  runDir: string
  slug: string
  artifacts: readonly ArtifactInfo[]
}): string | null {
  if (args.artifacts.length === 0) return null
  const rel = path.relative(args.runDir, path.join(args.runDir, 'failed', args.slug, 'playwright-mcp'))
  return `  - playwright-mcp: ${rel}/ (${args.artifacts.length} files)`
}

// Convenience: discover artifacts under each failure dir and render the
// bullet map. Returns slug → bullet text.
export function discoverPerFailureBullets(args: {
  runDir: string
  slugs: readonly string[]
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const slug of args.slugs) {
    const dir = path.join(args.runDir, 'failed', slug, 'playwright-mcp')
    const artifacts = listArtifacts(dir)
    const bullet = renderHealIndexBullet({ runDir: args.runDir, slug, artifacts })
    if (bullet) out[slug] = bullet
  }
  return out
}

export interface AttributionEntry {
  filename: string
  testSlug: string
}

// When multiple failures share a single MCP output dir, write a sidecar
// mapping each artifact filename to the most-recently-failed test before the
// file's mtime. Caller passes per-test endTimes from e2e-summary.json.
export function writeAttribution(args: {
  dir: string
  artifacts: readonly ArtifactInfo[]
  failureEndTimes: ReadonlyArray<{ slug: string; endTimeMs: number }>
}): AttributionEntry[] {
  const entries: AttributionEntry[] = []
  // Sort failures ascending by endTime to find "closest preceding".
  const sorted = [...args.failureEndTimes].sort((a, b) => a.endTimeMs - b.endTimeMs)
  for (const a of args.artifacts) {
    let chosen = sorted[0]?.slug ?? 'unknown'
    for (const f of sorted) {
      if (f.endTimeMs <= a.mtimeMs) chosen = f.slug
      else break
    }
    entries.push({ filename: a.name, testSlug: chosen })
  }
  fs.mkdirSync(args.dir, { recursive: true })
  fs.writeFileSync(
    path.join(args.dir, '_attribution.json'),
    JSON.stringify(entries, null, 2) + '\n',
  )
  return entries
}
