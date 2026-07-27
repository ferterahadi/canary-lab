import fs from 'fs'
import path from 'path'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import type { PlaywrightPlaybackEvent } from './run-detail'

/** Recursively sum the byte size of every regular file under `dir`. Returns 0
 *  when the directory is absent or unreadable — callers treat missing artifacts
 *  as "nothing to reclaim". Symlinks are not followed (lstat). */
export function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += dirSizeBytes(full)
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size } catch { /* vanished mid-walk */ }
    }
  }
  return total
}

/** Byte size of the heavy Playwright artifact directories (videos / traces /
 *  screenshots) for a run — the two dirs `trimRunArtifacts` removes. */
export function runArtifactBytes(logsDir: string, runId: string): number {
  const paths = buildRunPaths(runDirFor(logsDir, runId))
  return dirSizeBytes(paths.playwrightArtifactsDir) + dirSizeBytes(paths.playwrightArtifactsKeepDir)
}

/** Delete ONLY a run's Playwright artifact directories (`playwright-artifacts`
 *  + `playwright-artifacts-keep`), reclaiming the bulk of its disk while
 *  leaving the manifest, summary, logs, and run-index entry intact — the run
 *  stays listed and inspectable, just without video/trace playback. Returns the
 *  number of bytes freed. Caller is responsible for verifying the run is
 *  terminal; this does not stop a running orchestrator. */
export function trimRunArtifacts(logsDir: string, runId: string): number {
  const paths = buildRunPaths(runDirFor(logsDir, runId))
  let freed = 0
  for (const dir of [paths.playwrightArtifactsDir, paths.playwrightArtifactsKeepDir]) {
    if (!fs.existsSync(dir)) continue
    freed += dirSizeBytes(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return freed
}

export type PlaywrightArtifactKind = 'screenshot' | 'trace' | 'video' | 'other'

export interface PlaywrightArtifact {
  name: string
  kind: PlaywrightArtifactKind
  path: string
  url: string
  contentType?: string
  sizeBytes: number
  mtimeMs: number
}

export interface PlaywrightArtifactGroup {
  testName: string
  testTitle?: string
  artifacts: PlaywrightArtifact[]
}

export function indexPlaywrightArtifacts(
  runId: string,
  runDir: string,
  events: PlaywrightPlaybackEvent[] | undefined,
): PlaywrightArtifactGroup[] | undefined {
  const paths = buildRunPaths(runDir)
  const currentDir = paths.playwrightArtifactsDir
  const keepDir = paths.playwrightArtifactsKeepDir
  const hasCurrent = fs.existsSync(currentDir)
  const hasKeep = fs.existsSync(keepDir)
  if (!hasCurrent && !hasKeep) return undefined

  const groups = new Map<string, PlaywrightArtifactGroup>()
  const seen = new Set<string>()
  const seenRel = new Set<string>()
  const titleByName = new Map<string, string>()
  const testNameByArtifactDir = new Map<string, string>()
  for (const event of events ?? []) {
    if ('test' in event && event.test?.title) titleByName.set(event.test.name, event.test.title)
  }

  // Resolve a filePath against the current dir first, falling back to the
  // keep dir when current has been wiped by the next Playwright invocation.
  // The returned `rel` is always relative to `currentDir` so URL generation
  // and dedup keys stay stable regardless of which physical directory the
  // file currently lives in (the artifact-serving route looks in both).
  const resolveFile = (filePath: string): { resolved: string; rel: string } | null => {
    const abs = path.resolve(filePath)
    const relCurrent = path.relative(currentDir, abs)
    if (!relCurrent.startsWith('..') && !path.isAbsolute(relCurrent)) {
      if (hasCurrent && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { resolved: abs, rel: relCurrent }
      }
      if (hasKeep) {
        const keepCandidate = path.join(keepDir, relCurrent)
        if (fs.existsSync(keepCandidate) && fs.statSync(keepCandidate).isFile()) {
          return { resolved: keepCandidate, rel: relCurrent }
        }
      }
    }
    return null
  }

  const add = (testName: string, filePath: string, name?: string, contentType?: string): void => {
    const found = resolveFile(filePath)
    if (!found) return
    const { resolved, rel } = found
    const key = `${testName}:${rel}`
    if (seen.has(key) || seenRel.has(rel)) return
    const firstSegment = rel.split(path.sep)[0]
    testNameByArtifactDir.set(firstSegment, testName)
    seen.add(key)
    seenRel.add(rel)
    const group = groups.get(testName) ?? {
      testName,
      ...(titleByName.has(testName) ? { testTitle: titleByName.get(testName) } : {}),
      artifacts: [],
    }
    const stat = fs.statSync(resolved)
    group.artifacts.push({
      name: name || path.basename(resolved),
      kind: classifyArtifact(resolved, name, contentType),
      path: rel,
      url: artifactUrl(runId, rel),
      ...(contentType ? { contentType } : {}),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    })
    groups.set(testName, group)
  }

  for (const event of events ?? []) {
    if (event.type !== 'test-end') continue
    for (const attachment of event.attachments ?? []) {
      if (attachment.path) add(event.test.name, attachment.path, attachment.name, attachment.contentType)
    }
  }

  // Walk current first, then keep. Each file is keyed by its rel-against-
  // currentDir so a file present in both dirs is added once with the current
  // copy preferred.
  const walkDir = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const filePath of listFiles(dir)) {
      const rel = path.relative(dir, filePath)
      if (seenRel.has(rel)) continue
      const firstSegment = rel.split(path.sep)[0]
      // Synthesize a path rooted at currentDir so resolveFile picks whichever
      // dir actually contains the file and the rel-path → URL mapping stays
      // consistent.
      add(testNameByArtifactDir.get(firstSegment) ?? firstSegment, path.join(currentDir, rel))
    }
  }
  walkDir(currentDir)
  walkDir(keepDir)

  const indexed = [...groups.values()]
    .map((g) => ({
      ...g,
      artifacts: g.artifacts.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.testName.localeCompare(b.testName))
  return indexed.length > 0 ? indexed : undefined
}

export function classifyArtifact(filePath: string, name?: string, contentType?: string): PlaywrightArtifactKind {
  const label = `${name ?? ''} ${contentType ?? ''} ${path.basename(filePath)}`.toLowerCase()
  if (label.includes('image/') || /\.(png|jpe?g|webp)$/.test(label)) return 'screenshot'
  if (label.includes('trace') || label.includes('application/zip') || /\.zip$/.test(label)) return 'trace'
  if (label.includes('video') || label.includes('video/') || /\.(webm|mp4)$/.test(label)) return 'video'
  return 'other'
}

export function artifactUrl(runId: string, relPath: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${relPath.split(path.sep).map(encodeURIComponent).join('/')}`
}

export function listFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  visit(root)
  return out
}
