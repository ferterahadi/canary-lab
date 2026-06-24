import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEvaluationExportArchive } from './evaluation-export-archive'
import type { RunDetail, PlaywrightArtifact } from '../../runs/logic/run-store'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'

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
    expect(entries.map((entry) => entry.filename)).toEqual(['evaluation.html', 'run-id.mp4'])
    expect(entries.find((entry) => entry.filename === 'run-id.mp4')?.data.toString('utf8')).toBe('kept-video')
    expect(entries.find((entry) => entry.filename === 'evaluation.html')?.data.toString('utf8')).toContain('run-id.mp4')
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
