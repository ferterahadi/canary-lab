import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { extractTestsFromSource } from '../../../shared/ast-extractor'
import { attachSourceChanges } from './test-source-changes'

let root: string
let file: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
const original = `import { test, expect } from '@playwright/test'
test('first', () => {
  expect(1).toBe(1)
})
test('second', () => {
  expect(2).toBe(2)
})
`
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-source-markers-')))
  file = path.join(root, 'a.spec.ts')
  fs.writeFileSync(file, original)
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
  git('add', '.'); git('commit', '-qm', 'baseline')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
async function markers(source: string) {
  const { tests } = extractTestsFromSource(file, source)
  await attachSourceChanges(root, file, source, tests)
  return tests.map((test) => test.sourceChanges)
}
it('marks log-only edits from the same supplied source and leaves the other test clean', async () => {
  const edited = original.replace('  expect(1)', '  console.log("this")\n  console.log("that")\n  expect(1)')
  // Disk still has the old source: markers must match the response being assembled.
  expect(await markers(edited)).toEqual([
    { changedLines: [3, 4], count: 1 },
    { changedLines: [], count: 0 },
  ])
})
it('clears markers after the exact edit is committed', async () => {
  const edited = original.replace('expect(1).toBe(1)', 'expect(1).toBe(3)')
  expect((await markers(edited))[0]?.changedLines).toEqual([3])
  fs.writeFileSync(file, edited)
  git('add', '.'); git('commit', '-qm', 'edit')
  expect(await markers(edited)).toEqual([
    { changedLines: [], count: 0 }, { changedLines: [], count: 0 },
  ])
})
it('retains a review count for removed lines without highlighting an unchanged neighbor', async () => {
  expect((await markers(original.replace('  expect(1).toBe(1)\n', '')))[0]).toEqual({ changedLines: [], count: 1 })
})
it('leaves an uncommitted spec unmarked — there is no HEAD side to compare it against', async () => {
  const fresh = path.join(root, 'new.spec.ts')
  const { tests } = extractTestsFromSource(fresh, original)
  await attachSourceChanges(root, fresh, original, tests)
  expect(tests.map((test) => test.sourceChanges)).toEqual([undefined, undefined])
})
it('still marks a test the extractor gave no end line, by treating its declaration line as the span', async () => {
  const edited = original.replace('  expect(1).toBe(1)', '  expect(1).toBe(3)')
  // `endLine` is optional on ExtractedTest, and a test arriving without one must
  // stay addressable — dropping it would silently leave a real edit unmarked.
  const tests = [{ name: 'first', line: 2, bodySource: '{}', steps: [], readable: { version: 1, title: 'first', completeness: 'complete' as const, nodes: [] } }]
  await attachSourceChanges(root, file, edited, tests)
  expect(tests[0].sourceChanges).toEqual({ changedLines: [3], count: 1 })
})
