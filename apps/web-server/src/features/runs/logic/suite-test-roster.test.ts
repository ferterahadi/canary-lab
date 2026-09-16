import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, expect, it } from 'vitest'
import { mergeSuiteTestRoster, savedSuiteTestRoster, saveSuiteTestRoster, sourceTestRoster } from './suite-test-roster'
import filteredRun from './__fixtures__/envset-filtered-roster.json'

const roots: string[] = []
function suite(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-roster-')))
  roots.push(dir)
  fs.mkdirSync(path.join(dir, 'e2e'))
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('recovers the actual 45-case myy1 snapshot without duplicating tests moved during repair', () => {
  // Captured from 2026-09-14T0850-myy1; only absolute path prefixes were removed.
  // Two reporter locations precede their saved source locations after repair.
  expect(filteredRun.source).toHaveLength(45)
  expect(filteredRun.recorded).toHaveLength(4)
  const tests = mergeSuiteTestRoster(filteredRun.source, filteredRun.recorded)
  expect(tests).toHaveLength(45)
  expect(new Set(tests.map((test) => `${test.file}:${test.title}`)).size).toBe(45)
  expect(tests.map((test) => test.title)).toEqual(filteredRun.source.map((test) => test.title))
})

it('includes source declarations and literal loop cases regardless of config or envset', () => {
  const dir = suite()
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), "throw new Error('Config must not execute')")
  fs.writeFileSync(path.join(dir, 'e2e/a.spec.ts'), [
    "throw new Error('Historical source must not execute')",
    "if (process.env.MODE === 'meta') test('meta case', () => {})",
    "for (const name of ['one', 'two']) test(`local ${name}`, () => {})",
  ].join('\n'))
  const tests = sourceTestRoster(dir)
  expect(tests.map((test) => test.title)).toEqual(['meta case', 'local one', 'local two'])
  expect(mergeSuiteTestRoster(tests, [tests[1]])).toEqual(tests)
  saveSuiteTestRoster(dir)
  expect(savedSuiteTestRoster(dir)).toEqual(tests)
  const moved = `${dir}-moved`
  fs.renameSync(dir, moved)
  roots.push(moved)
  expect(savedSuiteTestRoster(moved).map((test) => test.file)).toEqual(tests.map((test) => test.file.replace(dir, moved)))
})

it('uses resolved generated names at the declaration and retains helper tests', () => {
  const dir = suite()
  fs.writeFileSync(path.join(dir, 'e2e/a.spec.ts'), 'for (const name of importedNames) test(`case ${name}`, () => {})')
  const [template] = sourceTestRoster(dir)
  const resolved = ['one', 'two'].map((name) => ({ ...template, title: `case ${name}` }))
  const helper = { ...template, title: 'helper case', originFile: path.join(dir, 'e2e/helper.ts') }
  expect(mergeSuiteTestRoster([template], [...resolved, helper])).toEqual([...resolved, helper])
})

it('keeps renamed source cases and disambiguates identical titles by file and line', () => {
  const dir = suite()
  fs.writeFileSync(path.join(dir, 'e2e/a.spec.ts'), "test('same', () => {})\ntest('same', () => {})\ntest('renamed', () => {})")
  fs.writeFileSync(path.join(dir, 'e2e/b.spec.ts'), "test('same', () => {})")
  const source = sourceTestRoster(dir)
  const recorded = [source[1], { ...source[2], title: 'old name' }, source[3]]
  const result = mergeSuiteTestRoster(source, recorded)
  expect(result.map((test) => test.title)).toEqual(['same', 'same', 'renamed', 'old name', 'same'])
  expect(result.filter((test) => test.title === 'same')).toHaveLength(3)
})

it('rejects saved inventory paths and source directory symlinks outside the suite', () => {
  const dir = suite()
  fs.writeFileSync(path.join(dir, '.canary-suite-tests.json'), JSON.stringify([{ file: '../outside.spec.ts', originFile: '../outside.spec.ts', title: 'outside', line: 1, originLine: 1 }]))
  expect(() => savedSuiteTestRoster(dir)).toThrow('outside the saved suite')
  const outside = suite()
  fs.writeFileSync(path.join(outside, 'e2e/outside.spec.ts'), "test('outside', () => {})")
  fs.rmSync(path.join(dir, 'e2e'), { recursive: true })
  fs.symlinkSync(path.join(outside, 'e2e'), path.join(dir, 'e2e'))
  expect(() => sourceTestRoster(dir)).toThrow('outside the suite')
})
