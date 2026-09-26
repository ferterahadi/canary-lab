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
