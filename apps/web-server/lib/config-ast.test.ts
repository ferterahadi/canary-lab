import { describe, it, expect } from 'vitest'
import {
  readFeatureConfig,
  writeFeatureConfig,
  readPlaywrightConfig,
  writePlaywrightConfig,
  type ConfigValue,
} from './config-ast'

// ─── feature.config patterns ────────────────────────────────────────────────

const FEATURE_PATTERN_A = `module.exports.config = {
  name: 'a',
  description: 'one',
  envs: ['local'],
  repos: [{ name: 'r', localPath: __dirname }],
  // keep me
  retries: -1,
}`

const FEATURE_PATTERN_B = `module.exports = {
  config: {
    name: 'b',
    timeout: process.env.CI ? 2 : 1,
  },
}`

const FEATURE_PATTERN_C = `const config = {
  name: 'c',
  flag: true,
}
module.exports = { config }`

describe('readFeatureConfig', () => {
  it('reads module.exports.config = {...}', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_A)
    const v = r.value as Record<string, ConfigValue>
    expect(v.name).toBe('a')
    expect(v.description).toBe('one')
    expect(v.envs).toEqual(['local'])
    expect(v.retries).toBe(-1)
    // localPath becomes a $expr placeholder
    expect(r.complexFields).toContain('repos[0].localPath')
  })

  it('reads module.exports = { config: {...} }', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_B)
    const v = r.value as Record<string, ConfigValue>
    expect(v.name).toBe('b')
    expect(r.complexFields).toContain('timeout')
    expect((v.timeout as { $expr: string }).$expr).toContain('process.env.CI')
  })

  it('reads module.exports = { config } shorthand', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_C)
    const v = r.value as Record<string, ConfigValue>
    expect(v.name).toBe('c')
    expect(v.flag).toBe(true)
  })

  it('throws on unrecognized source', () => {
    expect(() => readFeatureConfig('console.log("hi")')).toThrow(
      /Unable to locate feature config/,
    )
  })
})

describe('writeFeatureConfig', () => {
  it('round-trips a $expr placeholder unchanged', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_B)
    const out = writeFeatureConfig(FEATURE_PATTERN_B, r.value)
    // The non-literal expression source must survive verbatim.
    expect(out).toContain('process.env.CI ? 2 : 1')
  })

  it('preserves comments on untouched fields when patching one field', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_A)
    const next = { ...(r.value as Record<string, ConfigValue>), description: 'two' }
    const out = writeFeatureConfig(FEATURE_PATTERN_A, next)
    expect(out).toContain('// keep me')
    expect(out).toContain("'two'")
  })

  it('appends new keys', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_C)
    const next = { ...(r.value as Record<string, ConfigValue>), added: 42 }
    const out = writeFeatureConfig(FEATURE_PATTERN_C, next)
    expect(out).toMatch(/added:\s*42/)
  })

  it('drops keys removed from the patch', () => {
    const r = readFeatureConfig(FEATURE_PATTERN_C)
    const v = { ...(r.value as Record<string, ConfigValue>) }
    delete v.flag
    const out = writeFeatureConfig(FEATURE_PATTERN_C, v)
    expect(out).not.toMatch(/flag:/)
    expect(out).toContain("name: 'c'")
  })

  it('handles negative numbers', () => {
    const src = `module.exports.config = { n: 0 }`
    const out = writeFeatureConfig(src, { n: -7 })
    expect(out).toMatch(/n:\s*-7/)
  })

  it('handles arrays and nested objects', () => {
    const src = `module.exports.config = { a: [1] }`
    const out = writeFeatureConfig(src, { a: [1, 2, { x: 'y' }], b: null })
    expect(out).toMatch(/a:\s*\[\s*1,\s*2/)
    expect(out).toMatch(/x:\s*'y'/)
    expect(out).toMatch(/b:\s*null/)
  })

  it('throws on non-object input', () => {
    expect(() => writeFeatureConfig(FEATURE_PATTERN_A, [] as unknown as ConfigValue)).toThrow(
      /must be a plain object/,
    )
    expect(() => writeFeatureConfig(FEATURE_PATTERN_A, null)).toThrow(/must be a plain object/)
    expect(() => writeFeatureConfig(FEATURE_PATTERN_A, 5 as unknown as ConfigValue)).toThrow(
      /must be a plain object/,
    )
  })

  it('throws when no config object can be located', () => {
    expect(() => writeFeatureConfig('// nothing\n', { a: 1 })).toThrow(
      /Unable to locate feature config/,
    )
  })

  it('marks non-negation UnaryExpression as $expr', () => {
    const src = `module.exports.config = { a: !true, b: void 0 }`
    const r = readFeatureConfig(src)
    const v = r.value as Record<string, ConfigValue>
    expect((v.a as { $expr: string }).$expr).toContain('!')
    expect((v.b as { $expr: string }).$expr).toContain('void')
    expect(r.complexFields).toContain('a')
    expect(r.complexFields).toContain('b')
  })

  it('writes a newly-added $expr value through valueToNode', () => {
    const src = `module.exports.config = { a: 1 }`
    const out = writeFeatureConfig(src, { a: 1, b: { $expr: '__dirname' } })
    expect(out).toContain('b: __dirname')
  })

  it('writes a nested object through valueToNode', () => {
    const src = `module.exports.config = { a: 1 }`
    const out = writeFeatureConfig(src, { a: 1, nested: { x: 'y', n: 2 } })
    expect(out).toMatch(/nested:\s*\{[\s\S]*x:\s*'y'/)
  })

  it('falls back to null for unknown value shapes (defensive)', () => {
    const src = `module.exports.config = { a: 1 }`
    // Pass undefined to trigger the defensive default branch in valueToNode.
    const out = writeFeatureConfig(src, { a: undefined as unknown as ConfigValue })
    expect(out).toMatch(/a:\s*null/)
  })

  it('skips object properties with non-string-keyed names (e.g. numeric keys)', () => {
    const src = `module.exports.config = { name: 'k', 42: 'numeric', nested: { 7: 'inner', ok: 'yes' } }`
    const r = readFeatureConfig(src)
    const v = r.value as Record<string, ConfigValue>
    expect(v.name).toBe('k')
    // Numeric keys are dropped on the way in.
    expect((v as Record<string, unknown>)[42]).toBeUndefined()
    const nested = v.nested as Record<string, ConfigValue>
    expect(nested.ok).toBe('yes')
    expect((nested as Record<string, unknown>)[7]).toBeUndefined()
    // Round-trip should still work.
    const out = writeFeatureConfig(src, { ...v, name: 'k2' })
    expect(out).toContain("name: 'k2'")
  })

  it('reads explicit null literal', () => {
    const r = readFeatureConfig(`module.exports.config = { a: null }`)
    expect((r.value as Record<string, ConfigValue>).a).toBe(null)
  })

  it('preserves spread elements and computed keys when patching', () => {
    const src = `const base = { x: 1 }
module.exports.config = { ...base, ['dyn']: 1, name: 'old' }`
    const r = readFeatureConfig(src)
    const next = { ...(r.value as Record<string, ConfigValue>), name: 'new' }
    const out = writeFeatureConfig(src, next)
    expect(out).toContain('...base')
    expect(out).toContain("['dyn']")
    expect(out).toContain("name: 'new'")
  })

  it('returns null for missing AST nodes', () => {
    // An object property whose value is `undefined` exercises the early-return
    // path in nodeToValue when called recursively (e.g. via shorthand or holes).
    const src = `module.exports.config = { a: [, 2] }`
    const r = readFeatureConfig(src)
    const v = r.value as { a: ConfigValue[] }
    expect(v.a[0]).toBe(null)
    expect(v.a[1]).toBe(2)
  })
})

// ─── playwright.config patterns ─────────────────────────────────────────────

const PW_DEFINE_DEFAULT = `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  retries: process.env.CI ? 2 : 0,
})`

const PW_MODULE_EXPORTS_DEFINE = `const { defineConfig } = require('@playwright/test')
module.exports = defineConfig({
  testDir: './e2e',
})`

const PW_BARE_MODULE_EXPORTS = `module.exports = {
  testDir: './e2e',
  workers: 1,
}`

const PW_BARE_DEFAULT = `export default { testDir: './e2e' }`

describe('readPlaywrightConfig / writePlaywrightConfig', () => {
  it('reads export default defineConfig(...)', () => {
    const r = readPlaywrightConfig(PW_DEFINE_DEFAULT)
    const v = r.value as Record<string, ConfigValue>
    expect(v.testDir).toBe('./e2e')
    expect(r.complexFields).toContain('retries')
  })

  it('reads module.exports = defineConfig(...)', () => {
    const r = readPlaywrightConfig(PW_MODULE_EXPORTS_DEFINE)
    const v = r.value as Record<string, ConfigValue>
    expect(v.testDir).toBe('./e2e')
  })

  it('reads bare module.exports object', () => {
    const r = readPlaywrightConfig(PW_BARE_MODULE_EXPORTS)
    const v = r.value as Record<string, ConfigValue>
    expect(v.workers).toBe(1)
  })

  it('reads bare export default object', () => {
    const r = readPlaywrightConfig(PW_BARE_DEFAULT)
    const v = r.value as Record<string, ConfigValue>
    expect(v.testDir).toBe('./e2e')
  })

  it('round-trips $expr through writePlaywrightConfig', () => {
    const r = readPlaywrightConfig(PW_DEFINE_DEFAULT)
    const out = writePlaywrightConfig(PW_DEFINE_DEFAULT, r.value)
    expect(out).toContain('process.env.CI ? 2 : 0')
  })

  it('patches a literal field surgically', () => {
    const out = writePlaywrightConfig(PW_BARE_MODULE_EXPORTS, {
      testDir: './tests',
      workers: 4,
    })
    expect(out).toMatch(/testDir:\s*'\.\/tests'/)
    expect(out).toMatch(/workers:\s*4/)
  })

  it('throws on non-object input', () => {
    expect(() =>
      writePlaywrightConfig(PW_BARE_MODULE_EXPORTS, [] as unknown as ConfigValue),
    ).toThrow(/must be a plain object/)
  })

  it('skips non-defineConfig CallExpression on export default', () => {
    const src = `export default wrap({ testDir: './e2e' })
module.exports = { testDir: './fallback' }`
    expect((readPlaywrightConfig(src).value as Record<string, unknown>).testDir).toBe('./fallback')
  })

  it('skips assignments unrelated to module.exports', () => {
    const src = `foo.bar = 'baz'
module.exports = { testDir: './e2e' }`
    expect((readPlaywrightConfig(src).value as Record<string, unknown>).testDir).toBe('./e2e')
  })

  it('skips a feature config "config:" property whose value is neither ObjectExpression nor shorthand', () => {
    const src = `module.exports = { config: makeConfig() }
module.exports.config = { name: 'real' }`
    expect((readFeatureConfig(src).value as Record<string, unknown>).name).toBe('real')
  })

  it('skips non-AssignmentExpression statements when locating playwright config', () => {
    // The function must walk past the unrelated console.log and still find the
    // module.exports object below it.
    const src = `console.log('hello')\nmodule.exports = { testDir: './e2e' }`
    expect((readPlaywrightConfig(src).value as Record<string, unknown>).testDir).toBe('./e2e')
  })

  it('skips defineConfig calls whose arg is not an object literal', () => {
    const src = `const cfg = { testDir: './e2e' }
module.exports = defineConfig(cfg)
module.exports = { testDir: './bare' }`
    // defineConfig(cfg) gives a non-ObjectExpression arg → fall through to
    // the bare module.exports below.
    expect((readPlaywrightConfig(src).value as Record<string, unknown>).testDir).toBe('./bare')
  })

  it('skips non-defineConfig CallExpression assignments to module.exports', () => {
    const src = `module.exports = wrap({ testDir: './e2e' })
module.exports = { testDir: './fallback' }`
    expect((readPlaywrightConfig(src).value as Record<string, unknown>).testDir).toBe('./fallback')
  })

  it('throws when no playwright config is found', () => {
    expect(() => readPlaywrightConfig('// empty\n')).toThrow(
      /Unable to locate playwright config/,
    )
    expect(() => writePlaywrightConfig('// empty\n', { a: 1 })).toThrow(
      /Unable to locate playwright config/,
    )
  })
})
