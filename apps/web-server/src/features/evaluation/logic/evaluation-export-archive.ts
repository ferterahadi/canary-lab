import fs from 'fs'
import path from 'path'
import type { PlaywrightArtifact, RunDetail } from '../../runs/logic/run-store'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'
import { createEvaluationExport, type AssertionHtmlOptions } from './test-review-export'
import { computeFeatureCoverage } from '../../coverage/logic/coverage/service'
import { createZip } from '../../../shared/simple-zip'
import type { EvaluationArchiveContents } from './evaluation-export-types'
import { buildBehaviorCertificate } from './behavior-certificate'
import { robustnessJobStore } from '../../runs/logic/robustness/store'
import { readBundledAsset } from '../../../shared/bundled-assets'
import {
  BEHAVIOR_CERTIFICATE_CHECKER_FILENAME,
  BEHAVIOR_CERTIFICATE_FILENAME,
  type BehaviorCertificate,
} from '../../../../../../shared/verification-strength/certificate'

export type { EvaluationArchiveContents } from './evaluation-export-types'

export interface EvaluationExportArchiveOptions {
  logsDir: string
  /** Feature root — when set, the report attaches semantic coverage (if the
   *  feature has a generated PRD summary). Absent → Playwright-only grading. */
  featuresDir?: string
  audienceAdapter?: AssertionHtmlOptions['audienceAdapter']
  rewrite?: AssertionHtmlOptions['rewrite']
}

export async function buildEvaluationExportArchive(
  detail: RunDetail,
  options: EvaluationExportArchiveOptions,
): Promise<{ archiveBase: string; zip: Buffer; contents: EvaluationArchiveContents; certificate: BehaviorCertificate }> {
  const runPaths = buildRunPaths(runDirFor(options.logsDir, detail.runId))
  const videos = assertionVideos(
    detail.playwrightArtifacts,
    runPaths.playwrightArtifactsDir,
    runPaths.playwrightArtifactsKeepDir,
    detail.runId,
  )
  // Attach semantic coverage when the feature has a generated ledger (≥1
  // requirement). It's run-free + per-feature, so the report can lead with
  // coverage strength; otherwise it falls back to the Playwright grading.
  let coverage: AssertionHtmlOptions['coverage']
  if (options.featuresDir) {
    try {
      const ledger = computeFeatureCoverage({ featuresDir: options.featuresDir, logsDir: options.logsDir, feature: detail.manifest.feature })
      if (ledger.requirements.length > 0) coverage = ledger
    } catch { /* no feature dir / summary — fall back to Playwright grading */ }
  }
  const exported = await createEvaluationExport(detail, {
    audienceAdapter: options.audienceAdapter,
    rewrite: options.rewrite,
    videoLinksByTestName: videoLinksByTestName(videos),
    coverage,
  })
  const videoEntries = videos.map((video) => ({ filename: video.filename, data: fs.readFileSync(video.path) }))
  // The certificate rides in the same archive as the report (D7) with the
  // zero-dependency checker beside it, so the file a reader receives can be
  // re-verified without Canary Lab.
  const certificate = buildBehaviorCertificate(detail, { coverage, robustness: robustnessJobFor(options.logsDir, detail) })
  const zip = createZip([
    { filename: 'evaluation.html', data: Buffer.from(exported.html, 'utf8') },
    { filename: BEHAVIOR_CERTIFICATE_FILENAME, data: Buffer.from(JSON.stringify(certificate, null, 2), 'utf8') },
    { filename: BEHAVIOR_CERTIFICATE_CHECKER_FILENAME, data: Buffer.from(readBundledAsset(BEHAVIOR_CERTIFICATE_CHECKER_FILENAME), 'utf8') },
    ...exported.assets,
    ...videoEntries,
  ])
  return {
    archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(detail.runId)}`,
    zip,
    contents: { bytes: zip.length, videos: videoEntries.length, assets: exported.assets.length },
    certificate,
  }
}

/** The newest SETTLED Robustness Lab job built from this run. A job built from
 *  another run is another run's evidence, and a running job has no verdict yet
 *  — both read as "no matrix", which the certificate then says. */
function robustnessJobFor(logsDir: string, detail: RunDetail) {
  const store = robustnessJobStore(logsDir)
  const entry = store.forFeature(detail.manifest.feature).find((job) => job.runId === detail.runId && job.status !== 'running')
  return entry ? store.get(entry.jobId) : undefined
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
