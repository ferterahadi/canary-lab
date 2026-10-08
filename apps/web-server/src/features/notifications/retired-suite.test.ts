import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { isCommittedSuiteRetirement } from './retired-suite'
import { trackTempDirs } from '../../../../../tools/test-helpers/temp-dir'
import { initGitRepo, git } from '../../../../../tools/test-helpers/git-repo'

const tempDir = trackTempDirs('suite-retirement-')
const root = tempDir()

it('recognizes a committed suite deletion but not a missing working-tree folder', async () => {
  const featuresDir = path.join(root, 'features')
  const suite = path.join(featuresDir, 'shop')
  fs.mkdirSync(suite, { recursive: true })
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "module.exports = { name: 'shop' }\n")
  initGitRepo(root)

  fs.rmSync(suite, { recursive: true })
  expect(await isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(false)

  git(root, 'add', '-u')
  git(root, 'commit', '-qm', 'retire suite')
  expect(await isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(true)
  expect(await isCommittedSuiteRetirement(featuresDir, '../shop')).toBe(false)

  fs.mkdirSync(suite)
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "module.exports = { name: 'shop' }\n")
  expect(await isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(false)
})
