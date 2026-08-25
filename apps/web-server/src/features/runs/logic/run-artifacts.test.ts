import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readPlaywrightPlaybackEvents } from './run-store'
import { indexPlaywrightArtifacts } from './run-artifacts'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
})

describe('readPlaywrightPlaybackEvents / indexPlaywrightArtifacts', () => {
  it('tolerates missing events and artifacts', () => {
    expect(readPlaywrightPlaybackEvents(tmpDir)).toBeUndefined()
    expect(indexPlaywrightArtifacts('r1', tmpDir, undefined)).toBeUndefined()
  })

  it('ignores corrupt event lines and events without a type', () => {
    fs.mkdirSync(path.join(tmpDir, 'playwright-artifacts'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'playwright-events.jsonl'),
      [
        '',
        '{not json',
        JSON.stringify({ test: { name: 'missing-type', title: 'Missing type' } }),
        JSON.stringify({ type: 'test-begin', test: { name: 'case-a', title: 'Case A' } }),
      ].join('\n'),
    )

    expect(readPlaywrightPlaybackEvents(tmpDir)).toEqual([
      { type: 'test-begin', test: { name: 'case-a', title: 'Case A' } },
    ])
  })

  it('indexes attached artifacts defensively and discovers unmatched files', () => {
    const artifactsDir = path.join(tmpDir, 'playwright-artifacts')
    const caseDir = path.join(artifactsDir, 'case-a')
    const attachmentsDir = path.join(caseDir, 'attachments')
    fs.mkdirSync(caseDir, { recursive: true })
    fs.mkdirSync(attachmentsDir, { recursive: true })
    const screenshot = path.join(caseDir, 'screen.png')
    const attachedScreenshot = path.join(attachmentsDir, 'screen-hash.png')
    const video = path.join(caseDir, 'recording.webm')
    const notes = path.join(caseDir, 'notes.txt')
    fs.writeFileSync(screenshot, 'png')
    fs.writeFileSync(attachedScreenshot, 'png')
    fs.writeFileSync(video, 'webm')
    fs.writeFileSync(notes, 'notes')

    const result = indexPlaywrightArtifacts('r 1', tmpDir, [
      { type: 'test-begin', time: 't', test: { name: 'case-a', title: 'Case A', location: 'x:1' } },
      {
        type: 'step-begin',
        time: 't',
        test: { name: 'case-a', title: 'Case A' },
        step: { title: 'page.goto', category: 'pw:api' },
      },
      {
        type: 'test-end',
        time: 't',
        test: { name: 'case-a', title: 'Case A', location: 'x:1' },
        status: 'failed',
        passed: false,
        durationMs: 1,
        retry: 0,
        attachments: [
          { name: 'screenshot', contentType: 'image/png', path: attachedScreenshot },
          { name: 'duplicate-screenshot', contentType: 'image/png', path: attachedScreenshot },
          { name: 'outside', contentType: 'text/plain', path: path.join(tmpDir, 'outside.txt') },
          { name: 'missing', contentType: 'text/plain', path: path.join(caseDir, 'missing.txt') },
          { name: 'no-path', contentType: 'text/plain' },
        ],
      },
    ])

    expect(result).toEqual([
      {
        testName: 'case-a',
        testTitle: 'Case A',
        artifacts: [
          expect.objectContaining({ kind: 'other', path: 'case-a/notes.txt', name: 'notes.txt' }),
          expect.objectContaining({ kind: 'screenshot', path: 'case-a/attachments/screen-hash.png', name: 'screenshot' }),
          expect.objectContaining({ kind: 'screenshot', path: 'case-a/screen.png', name: 'screen.png' }),
          expect.objectContaining({ kind: 'video', path: 'case-a/recording.webm', name: 'recording.webm' }),
        ],
      },
    ])
    expect(result?.[0].artifacts[2].url).toBe('/api/runs/r%201/artifacts/case-a/screen.png')
  })

  it('indexes test-end events without attachments and empty artifact path segments', () => {
    const artifactsDir = path.join(tmpDir, 'playwright-artifacts')
    const caseDir = path.join(artifactsDir, 'case-b')
    fs.mkdirSync(caseDir, { recursive: true })
    fs.writeFileSync(path.join(caseDir, 'trace.zip'), 'zip')

    const result = indexPlaywrightArtifacts('r2', tmpDir, [
      {
        type: 'test-begin',
        time: 't',
        test: { name: 'case-b', title: '', location: 'x:1' },
      },
      {
        type: 'test-end',
        time: 't',
        test: { name: 'case-b', title: '', location: 'x:1' },
        status: 'passed',
        passed: true,
        durationMs: 1,
        retry: 0,
      },
    ])

    expect(result).toEqual([
      {
        testName: 'case-b',
        artifacts: [
          expect.objectContaining({ kind: 'trace', path: 'case-b/trace.zip' }),
        ],
      },
    ])
  })

  it('returns undefined for an empty artifacts directory and skips non-file entries', () => {
    const artifactsDir = path.join(tmpDir, 'playwright-artifacts')
    fs.mkdirSync(path.join(artifactsDir, 'empty-dir'), { recursive: true })
    fs.symlinkSync(path.join(artifactsDir, 'missing-target'), path.join(artifactsDir, 'link'))

    expect(indexPlaywrightArtifacts('r-empty', tmpDir, undefined)).toBeUndefined()
  })

  it('indexes discovered files without playback events', () => {
    const file = path.join(tmpDir, 'playwright-artifacts', 'unmatched', 'trace.zip')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'zip')

    expect(indexPlaywrightArtifacts('r-unmatched', tmpDir, undefined)).toEqual([
      {
        testName: 'unmatched',
        artifacts: [
          expect.objectContaining({
            name: 'trace.zip',
            kind: 'trace',
            path: 'unmatched/trace.zip',
          }),
        ],
      },
    ])
  })

  it('sorts multiple artifact groups by test name', () => {
    for (const slug of ['zebra-test', 'alpha-test']) {
      const file = path.join(tmpDir, 'playwright-artifacts', slug, 'trace.zip')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'zip')
    }
    const result = indexPlaywrightArtifacts('r-multi', tmpDir, undefined)
    expect(result?.map((g) => g.testName)).toEqual(['alpha-test', 'zebra-test'])
  })

  it('falls back to the keep dir when the live artifacts dir has been wiped', () => {
    // Simulates the state right after Playwright respawned for a heal-cycle
    // rerun: it cleared `playwright-artifacts/` (or only wrote one pw-slug
    // into it), but `playwright-artifacts-keep/` still has the prior cycle's
    // per-test directories.
    const keepDir = path.join(tmpDir, 'playwright-artifacts-keep')
    const keepCase = path.join(keepDir, 'pw-slug-a')
    fs.mkdirSync(keepCase, { recursive: true })
    fs.writeFileSync(path.join(keepCase, 'video.webm'), 'webm-keep')

    // The JSONL still references the original live-dir path (Playwright wrote
    // it before the next invocation wiped that file).
    const staleAttachmentPath = path.join(tmpDir, 'playwright-artifacts', 'pw-slug-a', 'video.webm')
    const result = indexPlaywrightArtifacts('r-keep', tmpDir, [
      {
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-a', title: 'Case A', location: 'x:1' },
        status: 'passed',
        passed: true,
        durationMs: 1,
        retry: 0,
        attachments: [{ name: 'video', contentType: 'video/webm', path: staleAttachmentPath }],
      },
    ])

    expect(result).toEqual([
      {
        testName: 'test-case-a',
        testTitle: 'Case A',
        artifacts: [
          expect.objectContaining({
            kind: 'video',
            name: 'video',
            path: 'pw-slug-a/video.webm',
            url: '/api/runs/r-keep/artifacts/pw-slug-a/video.webm',
          }),
        ],
      },
    ])
  })

  it('skips stale attachments that resolve to keep-dir directories', () => {
    const keepCase = path.join(tmpDir, 'playwright-artifacts-keep', 'pw-dir', 'video.webm')
    fs.mkdirSync(keepCase, { recursive: true })

    const staleAttachmentPath = path.join(tmpDir, 'playwright-artifacts', 'pw-dir', 'video.webm')
    expect(indexPlaywrightArtifacts('r-keep-dir', tmpDir, [
      {
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-dir', title: 'Case Dir', location: 'x:1' },
        status: 'failed',
        passed: false,
        durationMs: 1,
        retry: 0,
        attachments: [{ name: 'video', contentType: 'video/webm', path: staleAttachmentPath }],
      },
    ])).toBeUndefined()
  })

  it('prefers the live dir when the same pw-slug exists in both', () => {
    // Both dirs hold a video for the same pw-slug. The live dir is the most
    // recent (just-finished) Playwright invocation, so its file wins.
    const liveCase = path.join(tmpDir, 'playwright-artifacts', 'pw-slug-a')
    const keepCase = path.join(tmpDir, 'playwright-artifacts-keep', 'pw-slug-a')
    fs.mkdirSync(liveCase, { recursive: true })
    fs.mkdirSync(keepCase, { recursive: true })
    fs.writeFileSync(path.join(liveCase, 'video.webm'), 'webm-fresh')
    fs.writeFileSync(path.join(keepCase, 'video.webm'), 'webm-stale')

    const result = indexPlaywrightArtifacts('r-overlap', tmpDir, [
      {
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-a', title: 'Case A', location: 'x:1' },
        status: 'passed',
        passed: true,
        durationMs: 1,
        retry: 0,
        attachments: [{
          name: 'video',
          contentType: 'video/webm',
          path: path.join(liveCase, 'video.webm'),
        }],
      },
    ])

    expect(result).toHaveLength(1)
    expect(result?.[0].testName).toBe('test-case-a')
    expect(result?.[0].artifacts).toHaveLength(1)
    expect(result?.[0].artifacts[0].sizeBytes).toBe(Buffer.byteLength('webm-fresh'))
  })

  it('merges artifacts when each pw-slug lives in only one of the two dirs', () => {
    // Cycle 0 ran two tests; cycle 1 reran only test A so the live dir holds
    // just A, and the keep dir holds the prior copies of both A and B. The
    // indexer should surface both tests, picking A from live and B from keep.
    const liveA = path.join(tmpDir, 'playwright-artifacts', 'pw-a')
    const keepA = path.join(tmpDir, 'playwright-artifacts-keep', 'pw-a')
    const keepB = path.join(tmpDir, 'playwright-artifacts-keep', 'pw-b')
    fs.mkdirSync(liveA, { recursive: true })
    fs.mkdirSync(keepA, { recursive: true })
    fs.mkdirSync(keepB, { recursive: true })
    fs.writeFileSync(path.join(liveA, 'video.webm'), 'a-fresh')
    fs.writeFileSync(path.join(keepA, 'video.webm'), 'a-stale')
    fs.writeFileSync(path.join(keepB, 'video.webm'), 'b-stale')

    const result = indexPlaywrightArtifacts('r-merge', tmpDir, [
      {
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-a', title: 'Case A', location: 'x:1' },
        status: 'passed',
        passed: true,
        durationMs: 1,
        retry: 0,
        attachments: [{ name: 'video', contentType: 'video/webm', path: path.join(liveA, 'video.webm') }],
      },
      // No JSONL attachment for test B in this latest invocation — its
      // identity must be recovered from the keep dir's pw-slug.
    ])

    expect(result?.map((g) => g.testName).sort()).toEqual(['pw-b', 'test-case-a'])
    const a = result?.find((g) => g.testName === 'test-case-a')
    expect(a?.artifacts[0].sizeBytes).toBe(Buffer.byteLength('a-fresh'))
    const b = result?.find((g) => g.testName === 'pw-b')
    expect(b?.artifacts[0].sizeBytes).toBe(Buffer.byteLength('b-stale'))
  })
})
