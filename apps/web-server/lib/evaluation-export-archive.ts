import fs from 'fs'
import path from 'path'
import type { PlaywrightArtifact, RunDetail } from './run-store'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { createEvaluationExport, type AssertionHtmlOptions } from './test-review-export'
import { createZip } from './simple-zip'

export interface EvaluationExportArchiveOptions {
  logsDir: string
  audienceAdapter?: AssertionHtmlOptions['audienceAdapter']
  rewrite?: AssertionHtmlOptions['rewrite']
}

export async function buildEvaluationExportArchive(
  detail: RunDetail,
  options: EvaluationExportArchiveOptions,
): Promise<{ archiveBase: string; zip: Buffer }> {
  const runPaths = buildRunPaths(runDirFor(options.logsDir, detail.runId))
  const videos = assertionVideos(
    detail.playwrightArtifacts,
    runPaths.playwrightArtifactsDir,
    runPaths.playwrightArtifactsKeepDir,
    detail.runId,
  )
  const exported = await createEvaluationExport(detail, {
    audienceAdapter: options.audienceAdapter,
    rewrite: options.rewrite,
    videoLinksByTestName: videoLinksByTestName(videos),
  })
  return {
    archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(detail.runId)}`,
    zip: createZip([
      { filename: 'evaluation.html', data: Buffer.from(exported.html, 'utf8') },
      ...exported.assets,
      ...videos.map((video) => ({ filename: video.filename, data: fs.readFileSync(video.path) })),
    ]),
  }
}

function assertionVideos(
  groups: Array<{ testName: string; artifacts: PlaywrightArtifact[] }> | undefined,
  artifactsDir: string,
  artifactsKeepDir: string,
  runId: string,
): Array<{ filename: string; path: string; testName: string }> {
  // Mirror indexPlaywrightArtifacts.resolveFile: artifact.path is rooted at
  // the live artifacts dir, but after heal-cycle reruns the live dir only
  // holds the last invocation's outputs. Fall back to the keep dir so videos
  // from earlier invocations still make it into the export.
  const fileAt = (rel: string): string | null => {
    const live = path.resolve(artifactsDir, rel)
    if (fs.existsSync(live) && fs.statSync(live).isFile()) return live
    const kept = path.resolve(artifactsKeepDir, rel)
    if (fs.existsSync(kept) && fs.statSync(kept).isFile()) return kept
    return null
  }
  const videos = (groups ?? [])
    .flatMap((group) => group.artifacts.map((artifact) => ({ artifact, testName: group.testName })))
    .map(({ artifact, testName }) => {
      const rel = path.relative(artifactsDir, path.resolve(artifactsDir, artifact.path))
      const valid = !rel.startsWith('..') && !path.isAbsolute(rel)
      const filePath = valid ? fileAt(rel) : null
      return { artifact, filePath, testName, valid }
    })
    .filter((entry): entry is { artifact: PlaywrightArtifact; filePath: string; testName: string; valid: boolean } =>
      entry.valid && entry.artifact.kind === 'video' && entry.filePath !== null)
  return videos.map(({ artifact, filePath, testName }, idx) => {
    const ext = path.extname(filePath) || extensionForContentType(artifact.contentType) || '.webm'
    const suffix = videos.length === 1 ? '' : `-${idx + 1}`
    const filename = `${safeFilename(runId)}${suffix}${ext}`
    return { filename, path: filePath, testName }
  })
}

function videoLinksByTestName(videos: Array<{ filename: string; testName: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const video of videos) out[video.testName] = [...(out[video.testName] ?? []), video.filename]
  return out
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  if (contentType === 'video/mp4') return '.mp4'
  if (contentType === 'video/webm') return '.webm'
  return undefined
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}
