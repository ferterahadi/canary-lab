import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyCandidateSource } from './candidate'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture(): { baseline: string; candidate: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-source-')); roots.push(root)
  const baseline = path.join(root, 'baseline')
  const candidate = path.join(root, 'candidate')
  for (const directory of [baseline, candidate]) {
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), '{"scripts":{"build":"tsup"}}\n')
    fs.writeFileSync(path.join(directory, 'yarn.lock'), 'frozen\n')
    fs.writeFileSync(path.join(directory, 'src/index.ts'), 'export const value = 1\n')
    fs.writeFileSync(path.join(directory, 'dist/index.js'), 'generated\n')
  }
  return { baseline, candidate }
}

it('accepts source edits while ignoring generated dist in both inventories', () => {
  const { baseline, candidate } = fixture()
  fs.writeFileSync(path.join(candidate, 'src/index.ts'), 'export const value = 2\n')
  fs.writeFileSync(path.join(candidate, 'dist/index.js'), 'stale generated output\n')
  expect(verifyCandidateSource(candidate, baseline).changedSourceFiles).toEqual(['src/index.ts'])
})

it('rejects configuration changes and linked source files', () => {
  const { baseline, candidate } = fixture()
  fs.writeFileSync(path.join(candidate, 'package.json'), '{"scripts":{"build":"unsafe"}}\n')
  expect(() => verifyCandidateSource(candidate, baseline)).toThrow('frozen non-source')
  fs.copyFileSync(path.join(baseline, 'package.json'), path.join(candidate, 'package.json'))
  fs.rmSync(path.join(candidate, 'src/index.ts'))
  fs.symlinkSync(path.join(baseline, 'src/index.ts'), path.join(candidate, 'src/index.ts'))
  expect(() => verifyCandidateSource(candidate, baseline)).toThrow('link or special file')
})
