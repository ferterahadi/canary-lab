import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { expect, it } from 'vitest'
import { normalizeFixCaptureNames } from './fix-capture-names'
import { readManifest, updateManifest, writeManifest } from './runtime/manifest'
import type { RunManifest } from '../../../../../../shared/run-manifest'
import { diffNamesSinceSnapshot } from '../../../shared/git-repo'
import type { RunFixCaptureRepo } from '../../../../../../shared/run-state'
import { initGitRepo } from '../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('capture-names-')

const repo: RunFixCaptureRepo = { repoName: 'app', repoRoot: '/repo', baseSha: 'base', files: 1, patchPath: '/patch', patchFile: 'app.patch' }

it('keeps old captures without filenames and marked literal filenames intact', () => {
  expect(normalizeFixCaptureNames(repo)).toBe(repo)
  const literal = { ...repo, fileNames: ['"a\\tb"'], fileNamesFormat: 'literal' as const }
  expect(normalizeFixCaptureNames(literal)).toBe(literal)
})

it('reads real Git names literally and normalizes legacy names once across manifest updates', async () => {
  const root = tempDir()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const names = [' leading and trailing ', 'café.txt', 'tab\tfile', 'line\nfile', 'back\\slash', '"literal"', 'left -> right']
  for (const name of names) fs.writeFileSync(path.join(root, name), 'before')
  initGitRepo(root, { branch: 'main' })
  for (const name of names) fs.writeFileSync(path.join(root, name), 'after')
  const literal = await diffNamesSinceSnapshot(root, 'HEAD')
  expect([...literal].sort()).toEqual([...names].sort())
  for (const quotePath of ['true', 'false']) {
    git('config', 'core.quotePath', quotePath)
    const legacy = git('diff', '--name-only', 'HEAD').trimEnd().split('\n')
    const normalized = normalizeFixCaptureNames({ ...repo, fileNames: legacy })
    expect(normalized.fileNames?.slice().sort()).toEqual([...names].sort())
    expect(normalized.fileNamesFormat).toBe('literal')
    const file = path.join(root, 'manifest.json')
    const m = { runId: 'run', feature: 'suite', featureDir: root, status: 'failed', startedAt: 'now', services: [], healCycles: 1,
      fixCapture: { capturedAt: 'now', repos: [{ ...repo, fileNames: legacy }] } } satisfies RunManifest
    writeManifest(file, m)
    const savedBytes = fs.readFileSync(file, 'utf8')
    expect(readManifest(file)?.fixCapture?.repos[0]).toEqual(normalized)
    expect(fs.readFileSync(file, 'utf8')).toBe(savedBytes) // a read does not rewrite historical evidence
    updateManifest(file, { status: 'passed' })
    expect(readManifest(file)?.fixCapture?.repos[0]).toEqual(normalized)
    updateManifest(file, { status: 'failed' })
    expect(readManifest(file)?.fixCapture?.repos[0]).toEqual(normalized)
  }
})
