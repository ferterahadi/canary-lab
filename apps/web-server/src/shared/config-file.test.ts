import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FEATURE_CONFIG_NAMES, findExistingConfig } from './config-file'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-config-file-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

it('keeps cjs, js, ts precedence and returns null when none exist', () => {
  expect(findExistingConfig(dir, FEATURE_CONFIG_NAMES)).toBeNull()
  for (const format of ['ts', 'js', 'cjs']) {
    const file = path.join(dir, `feature.config.${format}`)
    fs.writeFileSync(file, '')
    expect(findExistingConfig(dir, FEATURE_CONFIG_NAMES)).toEqual({ path: file, format })
  }
})

it('returns null for missing directories and empty candidate lists', () => {
  expect(findExistingConfig(path.join(dir, 'missing'), FEATURE_CONFIG_NAMES)).toBeNull()
  expect(findExistingConfig(dir, [])).toBeNull()
})

it('uses the supplied order for other config families', () => {
  for (const format of ['cjs', 'js', 'ts']) fs.writeFileSync(path.join(dir, `playwright.config.${format}`), '')
  expect(findExistingConfig(dir, ['playwright.config.ts', 'playwright.config.js', 'playwright.config.cjs']))
    .toEqual({ path: path.join(dir, 'playwright.config.ts'), format: 'ts' })
  expect(findExistingConfig(dir, ['playwright.config.js', 'playwright.config.ts']))
    .toEqual({ path: path.join(dir, 'playwright.config.js'), format: 'js' })
})

it('selects existing directories and preserves symlink paths without resolving them', () => {
  const candidate = path.join(dir, 'feature.config.cjs')
  fs.mkdirSync(candidate)
  expect(findExistingConfig(dir, FEATURE_CONFIG_NAMES)).toEqual({ path: candidate, format: 'cjs' })
  fs.rmdirSync(candidate)
  const target = path.join(dir, 'source.js')
  fs.writeFileSync(target, 'not valid JavaScript')
  fs.symlinkSync(target, candidate)
  expect(findExistingConfig(dir, FEATURE_CONFIG_NAMES)).toEqual({ path: candidate, format: 'cjs' })
  fs.unlinkSync(target)
  expect(findExistingConfig(dir, FEATURE_CONFIG_NAMES)).toBeNull()
})
