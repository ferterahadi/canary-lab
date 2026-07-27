// Tests that require vi.mock to reach branches inside collectTests (service.ts lines
// 86, 90-91) that are unreachable with real spec files, since the AST extractor never
// sets sourceFile and only sets requirements/pathTypes via Playwright tags.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../../../../shared/ast-extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../shared/ast-extractor')>()
  return {
    ...original,
    extractTestsFromSource: vi.fn(original.extractTestsFromSource),
  }
})

import { runCoverageEngine as runCoverageEngineReal, regeneratePrdSummary as regeneratePrdSummaryReal, listFeatureDocs } from './service'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import { fakeSummarize, fakePropose } from './__fixtures__/fake-coverage-agents'

// Coverage generation is LLM-only; inject the fake agent via the dep seams.
const regeneratePrdSummary = (args: Parameters<typeof regeneratePrdSummaryReal>[0]) =>
  regeneratePrdSummaryReal(args, { summarize: fakeSummarize })

const runCoverageEngine = (args: Parameters<typeof runCoverageEngineReal>[0]) =>
  runCoverageEngineReal(args, { propose: fakePropose })

let tmpDir: string

let featuresDir: string

let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-service-mocked-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  vi.mocked(extractTestsFromSource).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFeature(name: string): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  // Write a real spec file so listSpecFiles picks it up.
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item')
  return dir
}

describe('listFeatureDocs — symlink edge cases (service.ts lines 637, 650)', () => {
  it('skips a symlinked entry whose target is a directory, not a file (line 637 branch)', () => {
    const dir = writeFeature('symlinked_dir_doc')
    const docsDir = path.join(dir, 'docs')
    // Real target is a directory (not a regular file). lstatSync reports a
    // symlink, but the follow-through statSync succeeds and reports a
    // directory — `stat && !stat.isFile()` must skip it entirely.
    const targetDir = path.join(dir, 'a-real-directory')
    fs.mkdirSync(targetDir)
    fs.symlinkSync(targetDir, path.join(docsDir, 'dirlink.md'), 'dir')

    const listing = listFeatureDocs(featuresDir, 'symlinked_dir_doc')

    expect(listing.docs.find((d) => d.relPath === 'dirlink.md')).toBeUndefined()
    // The real doc written by writeFeature() is still listed normally.
    expect(listing.docs.find((d) => d.relPath === 'spec.md')).toBeDefined()
  })

  it('reports linkTarget as undefined when readlinkSync throws after lstatSync already confirmed a symlink (line 650 catch)', () => {
    const dir = writeFeature('symlinked_race_doc')
    const docsDir = path.join(dir, 'docs')
    const targetFile = path.join(dir, 'real-target.md')
    fs.writeFileSync(targetFile, '# real content')
    const linkPath = path.join(docsDir, 'linked.md')
    fs.symlinkSync(targetFile, linkPath, 'file')

    // Simulate the target being unlinked between the lstatSync/statSync calls
    // and the readlinkSync call: readlinkSync throws for this exact symlink.
    // No other fs.readlinkSync calls happen inside listFeatureDocs, so this
    // narrow throw-only stub is safe.
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (target === linkPath) throw new Error('ENOENT: race — link vanished')
      throw new Error('unexpected readlinkSync call in test: ' + String(target))
    }) as unknown as typeof fs.readlinkSync)

    try {
      const listing = listFeatureDocs(featuresDir, 'symlinked_race_doc')
      const doc = listing.docs.find((d) => d.relPath === 'linked.md')
      expect(doc).toBeDefined()
      expect(doc?.linked).toBe(true)
      expect(doc?.linkTarget).toBeUndefined()
      // stat succeeded (the target file exists) so this is not a dangling/broken link.
      expect(doc?.broken).toBeUndefined()
    } finally {
      readlinkSpy.mockRestore()
    }
  })
})
