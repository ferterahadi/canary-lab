import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  SPEC_SELECTION_RULE,
  assertStableSpecSelection,
  findPlaywrightConfig,
  findVariableSpecSelection,
  isPlaywrightConfigPath,
} from './playwright-config'

const config = (body: string) =>
  `import { defineConfig } from '@playwright/test'\nexport default defineConfig({ ${body} })\n`

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pw-config-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('isPlaywrightConfigPath', () => {
  it('accepts every config extension, at any depth', () => {
    expect(isPlaywrightConfigPath('playwright.config.ts')).toBe(true)
    expect(isPlaywrightConfigPath('playwright.config.js')).toBe(true)
    expect(isPlaywrightConfigPath('nested/playwright.config.cjs')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isPlaywrightConfigPath('e2e/checkout.spec.ts')).toBe(false)
    expect(isPlaywrightConfigPath('playwright.config.mts')).toBe(false)
  })
})

describe('findPlaywrightConfig', () => {
  it('finds the config whatever its extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.cjs'), config("testDir: './e2e'"))
    expect(findPlaywrightConfig(tmpDir)).toBe(path.join(tmpDir, 'playwright.config.cjs'))
  })

  it('returns null when the feature has no config', () => {
    expect(findPlaywrightConfig(tmpDir)).toBeNull()
  })
})

describe('findVariableSpecSelection', () => {
  it('flags a testMatch computed from the recorded environment', () => {
    const source = [
      "import fs from 'fs'",
      "import { defineConfig } from '@playwright/test'",
      "const manifest = process.env.CANARY_LAB_MANIFEST_PATH",
      "const mode = manifest ? JSON.parse(fs.readFileSync(manifest, 'utf8')).env : undefined",
      'export default defineConfig({',
      "  testDir: './e2e',",
      "  testMatch: mode ? `**/*.${mode}.spec.ts` : '**/*.spec.ts',",
      '})',
    ].join('\n')
    expect(findVariableSpecSelection(source)).toEqual(['testMatch'])
  })

  it('passes a config whose selection fields are literals', () => {
    expect(findVariableSpecSelection(config("testDir: './e2e', testMatch: '**/*.spec.ts'"))).toEqual([])
  })

  it('ignores a computed field that does not narrow the roster', () => {
    expect(findVariableSpecSelection(config('workers: process.env.CI ? 2 : 1'))).toEqual([])
  })

  it('flags every selection field, including a nested one', () => {
    const source = config(
      "testDir: dir, testIgnore: ignore, grep: new RegExp(mode), grepInvert: inv, projects: [{ name: 'a', testMatch: m }]",
    )
    expect(findVariableSpecSelection(source).sort()).toEqual(
      ['grep', 'grepInvert', 'projects[0].testMatch', 'testDir', 'testIgnore'],
    )
  })

  it('reports nothing for a config it cannot parse', () => {
    // An unreadable config already fails loudly at `playwright test`. Refusing a
    // run on a parse we could not perform would be a verdict about our parser.
    expect(findVariableSpecSelection('this is not a playwright config')).toEqual([])
  })
})

describe('assertStableSpecSelection', () => {
  it('allows a suite with no config at all — Playwright\'s default glob is constant', () => {
    expect(() => assertStableSpecSelection(tmpDir, 'checkout')).not.toThrow()
  })

  it('allows a config whose roster is the same for every envset', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), config("testMatch: '**/*.spec.ts'"))
    expect(() => assertStableSpecSelection(tmpDir, 'checkout')).not.toThrow()
  })

  it('refuses an envset-dependent roster with the fields to rewrite', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), config('testMatch: mode ? a : b'))
    let thrown: unknown
    try {
      assertStableSpecSelection(tmpDir, 'checkout')
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error).message).toContain('checkout: playwright.config.ts selects specs with a computed testMatch')
    expect((thrown as Error).message).toContain(SPEC_SELECTION_RULE)
    expect(thrown).toMatchObject({
      statusCode: 409,
      specSelection: {
        feature: 'checkout',
        config: path.join(tmpDir, 'playwright.config.ts'),
        fields: ['testMatch'],
        rule: SPEC_SELECTION_RULE,
      },
    })
  })
})
