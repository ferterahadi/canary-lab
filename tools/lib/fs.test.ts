import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../test-helpers/temp-dir'
import { REPO, walk } from './fs.mjs'

const tempDir = trackTempDirs('canary-tools-walk-')

function tree(files: string[]): string {
  const root = tempDir()
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), '')
  }
  return root
}

const sorted = (paths: string[]) => [...paths].sort()

it('lists every file as an absolute path by default', () => {
  const root = tree(['a.ts', 'nested/b.md'])
  expect(sorted(walk(root))).toEqual([path.join(root, 'a.ts'), path.join(root, 'nested/b.md')])
})

it('applies ext, skip and excludeTests, and returns /-joined paths relative to a root', () => {
  const root = tree(['src/a.ts', 'src/a.test.ts', 'src/b.tsx', 'src/c.md', 'src/dist/d.ts', 'node_modules/e.ts'])
  expect(sorted(walk(root, { ext: /\.tsx?$/, skip: ['node_modules', 'dist'], excludeTests: true, relativeTo: root })))
    .toEqual(['src/a.ts', 'src/b.tsx'])
  expect(sorted(walk(root, { ext: /\.tsx?$/, relativeTo: root })))
    .toEqual(['node_modules/e.ts', 'src/a.test.ts', 'src/a.ts', 'src/b.tsx', 'src/dist/d.ts'])
})

it('drops an entry and everything under it when onEntry returns false, before skip applies', () => {
  const root = tree(['keep/a.ts', 'drop/b.ts', 'dist/c.ts'])
  const seen: string[] = []
  const files = walk(root, {
    skip: ['dist'],
    relativeTo: root,
    onEntry: (p: string, name: string) => { seen.push(name); return name !== 'drop' },
  })
  expect(sorted(files)).toEqual(['keep/a.ts'])
  expect(seen).toContain('dist')
  expect(seen).not.toContain('b.ts')
})

it('resolves REPO to the checkout root', () => {
  expect(fs.existsSync(path.join(REPO, 'tools/lib/fs.mjs'))).toBe(true)
})
