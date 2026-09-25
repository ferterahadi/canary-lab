import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, expect, it } from 'vitest'
import { isCommittedSuiteRetirement } from './retired-suite'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-retirement-'))
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('recognizes a committed suite deletion but not a missing working-tree folder', () => {
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'ignore' }) }
  const featuresDir = path.join(root, 'features')
  const suite = path.join(featuresDir, 'shop')
  fs.mkdirSync(suite, { recursive: true })
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "module.exports = { name: 'shop' }\n")
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'add suite')

  fs.rmSync(suite, { recursive: true })
  expect(isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(false)

  git('add', '-u')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'retire suite')
  expect(isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(true)
  expect(isCommittedSuiteRetirement(featuresDir, '../shop')).toBe(false)

  fs.mkdirSync(suite)
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "module.exports = { name: 'shop' }\n")
  expect(isCommittedSuiteRetirement(featuresDir, 'shop')).toBe(false)
})
