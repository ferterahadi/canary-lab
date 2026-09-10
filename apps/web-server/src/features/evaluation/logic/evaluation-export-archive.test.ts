import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEvaluationExportArchive } from './evaluation-export-archive'
import type { RunDetail, PlaywrightArtifact } from '../../runs/logic/run-store'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'
import { robustnessJobStore } from '../../runs/logic/robustness/store'
import type { RobustnessJobManifest } from '../../../../../../shared/robustness/jobs'

let tmpDir: string | undefined

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

function writeTmpFeature(logsDir: string, featureName: string): string {
  const featuresDir = path.join(path.dirname(logsDir), 'features')
  const featureDir = path.join(featuresDir, featureName.toLowerCase().replace(/ /g, '-'))
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(featureName)}, description: 'd', envs: ['local'], repos: [], featureDir: __dirname } }`,
  )
  return featuresDir
}

describe('buildEvaluationExportArchive — coverage attachment', () => {
  it('skips coverage when featuresDir is absent', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-nocov-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    // No featuresDir passed → options.featuresDir is undefined → coverage block skipped
    const built = await buildEvaluationExportArchive(detail(), { logsDir })
    const entries = zipEntries(built.zip)
    expect(entries.find((e) => e.filename === 'evaluation.html')).toBeTruthy()
  })

  it('attaches coverage when the feature has a PRD summary with requirements (if-true branch)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-withreqs-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const featuresDir = writeTmpFeature(logsDir, 'Checkout Flow')
    // Use the realpath so the docs dir matches the featureDir that loadFeatures returns via __dirname.
    const featureDir = fs.realpathSync(path.join(featuresDir, 'checkout-flow'))
    const docsDir = path.join(featureDir, 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(
      path.join(docsDir, '_prd-summary.json'),
      JSON.stringify({
        requirements: [{ id: 'R1', title: 'Create todo', text: 'A user can create a new todo item', pathTypes: ['happy'] }],
        requirementsHash: 'hash-abc',
        docsHash: 'hash-def',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceDocs: [],
      }),
    )
    const built = await buildEvaluationExportArchive(detail(), { logsDir, featuresDir })
    const entries = zipEntries(built.zip)
    expect(entries.find((e) => e.filename === 'evaluation.html')).toBeTruthy()
  })

  it('skips coverage when feature has no PRD summary (0 requirements → if-false branch)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-zeroq-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    // Feature exists (feature.config.cjs) but no _prd-summary.json → 0 requirements
    const featuresDir = writeTmpFeature(logsDir, 'Checkout Flow')
    const built = await buildEvaluationExportArchive(detail(), { logsDir, featuresDir })
    // Should still produce a valid HTML archive — no throw
    const entries = zipEntries(built.zip)
    expect(entries.find((e) => e.filename === 'evaluation.html')).toBeTruthy()
  })
})

describe('buildEvaluationExportArchive — the behavior certificate', () => {
  it('bundles certificate.json and the offline checker beside the report, and returns the certificate', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-cert-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })

    const built = await buildEvaluationExportArchive(detail(), { logsDir })

    const names = zipEntries(built.zip).map((e) => e.filename)
    expect(names).toEqual(expect.arrayContaining(['evaluation.html', 'certificate.json', 'verify-certificate.mjs']))
    const inZip = JSON.parse(zipEntries(built.zip).find((e) => e.filename === 'certificate.json')!.data.toString('utf8'))
    expect(inZip).toEqual(JSON.parse(JSON.stringify(built.certificate)))
    expect(built.certificate.format).toBe('canary-lab/behavior-certificate@2')
    expect(built.certificate.run.runId).toBe(detail().runId)
    expect(zipEntries(built.zip).find((e) => e.filename === 'verify-certificate.mjs')!.data.toString('utf8')).toContain('behavior-certificate@2')
    // The checker and the certificate are not report assets: the contents record
    // keeps describing the report the way it did.
    expect(built.contents.assets).toBe(0)
  })
})

describe('buildEvaluationExportArchive', () => {
  it('includes videos retained in the keep dir and skips unsafe or missing artifacts', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-'))
    const logsDir = path.join(tmpDir, 'logs')
    const runId = 'run id'
    const runPaths = buildRunPaths(runDirFor(logsDir, runId))
    const keptVideo = path.join(runPaths.playwrightArtifactsKeepDir, 'checkout', 'video')
    fs.mkdirSync(path.dirname(keptVideo), { recursive: true })
    fs.writeFileSync(keptVideo, 'kept-video')

    const outsideVideo = path.join(tmpDir, 'outside.webm')
    fs.writeFileSync(outsideVideo, 'outside-video')

    const built = await buildEvaluationExportArchive(detail({
      runId,
      playwrightArtifacts: [{
        testName: 'checkout works',
        artifacts: [
          artifact({ name: 'retained video', path: 'checkout/video', contentType: 'video/mp4' }),
          artifact({ name: 'missing video', path: 'checkout/missing.webm', contentType: 'video/webm' }),
          artifact({ name: 'unsafe video', path: outsideVideo, contentType: 'video/webm' }),
          artifact({ name: 'trace', kind: 'trace', path: 'checkout/trace.zip', contentType: 'application/zip' }),
        ],
      }],
    }), { logsDir })

    const entries = zipEntries(built.zip)
    expect(built.archiveBase).toBe('canary-lab-evaluation-Checkout-Flow-run-id')
    expect(entries.map((entry) => entry.filename)).toEqual(['evaluation.html', 'certificate.json', 'verify-certificate.mjs', 'run-id.mp4'])
    expect(entries.find((entry) => entry.filename === 'run-id.mp4')?.data.toString('utf8')).toBe('kept-video')
    expect(entries.find((entry) => entry.filename === 'evaluation.html')?.data.toString('utf8')).toContain('run-id.mp4')
    // Contents count what LANDED in the zip, not what the run declared: three
    // video artifacts were offered and only the retained one resolved, and the
    // trace is not an archive member at all. Reporting 3 videos here would
    // promise the reader files the download does not contain.
    expect(built.contents).toEqual({ bytes: built.zip.length, videos: 1, assets: 0 })
  })
})

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1',
      feature: 'Checkout Flow',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    },
    summary: {
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['checkout works'],
      failed: [],
    },
    ...overrides,
  }
}

function artifact(overrides: Partial<PlaywrightArtifact> = {}): PlaywrightArtifact {
  return {
    name: 'video',
    kind: 'video',
    path: 'checkout/video.webm',
    url: '/artifacts/checkout/video.webm',
    contentType: 'video/webm',
    sizeBytes: 10,
    mtimeMs: 1,
    ...overrides,
  }
}

function zipEntries(zip: Buffer): Array<{ filename: string; data: Buffer }> {
  const entries: Array<{ filename: string; data: Buffer }> = []
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26)
    const dataLength = zip.readUInt32LE(offset + 18)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength
    entries.push({
      filename: zip.subarray(nameStart, dataStart).toString('utf8'),
      data: zip.subarray(dataStart, dataStart + dataLength),
    })
    offset = dataStart + dataLength
  }
  return entries
}

describe('buildEvaluationExportArchive — the Robustness Lab job joins the certificate', () => {
  const job = (over: Partial<RobustnessJobManifest>): RobustnessJobManifest => ({
    jobId: 'rj-x',
    feature: 'Checkout Flow',
    runId: 'run-1',
    envelope: { format: 'canary-lab/robustness-envelope@1', latency: { ms: 250 } },
    status: 'done',
    startedAt: '2026-01-01T00:02:00.000Z',
    endedAt: '2026-01-01T00:12:00.000Z',
    cells: { planned: 1, done: 1 },
    findings: [],
    skipped: [],
    log: '',
    ...over,
  })

  it('attaches the newest settled job built from THIS run; a running job or another run\'s job reads as no matrix', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-eval-archive-robust-'))
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const store = robustnessJobStore(logsDir)

    const none = await buildEvaluationExportArchive(detail(), { logsDir })
    expect(none.certificate.robustness).toBeUndefined()

    store.save(job({ jobId: 'rj-other-run', runId: 'run-2' }))
    store.save(job({ jobId: 'rj-running', status: 'running', endedAt: undefined, startedAt: '2026-01-01T00:20:00.000Z' }))
    const notYet = await buildEvaluationExportArchive(detail(), { logsDir })
    expect(notYet.certificate.robustness).toBeUndefined()
    expect(notYet.certificate.notProven.join('\n')).toContain('No Robustness Lab matrix ran against this run')

    store.save(job({ jobId: 'rj-old', status: 'aborted', startedAt: '2026-01-01T00:01:00.000Z', cells: { planned: 1, done: 0 } }))
    store.save(job({ jobId: 'rj-newest', startedAt: '2026-01-01T00:05:00.000Z' }))
    const built = await buildEvaluationExportArchive(detail(), { logsDir })
    expect(built.certificate.robustness?.jobId).toBe('rj-newest')
    expect(built.certificate.robustness?.cells).toEqual({ planned: 1, judged: 1, notRun: 0 })
    const inZip = JSON.parse(zipEntries(built.zip).find((e) => e.filename === 'certificate.json')!.data.toString('utf8'))
    expect(inZip.robustness.jobId).toBe('rj-newest')
  })
})
