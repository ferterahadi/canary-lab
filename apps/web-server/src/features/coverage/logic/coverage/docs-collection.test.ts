import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  computeDocsHash,
  isGeneratedDoc,
  readDocsCollection,
  type DocEntry,
} from './docs-collection'

let tmpDir: string
let featureDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-docs-collection-')))
  featureDir = path.join(tmpDir, 'feature')
  fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeDoc(name: string, content: string) {
  fs.writeFileSync(path.join(featureDir, 'docs', name), content)
}

describe('computeDocsHash', () => {
  it('is order-independent of enumeration', () => {
    const a: DocEntry[] = [
      { relPath: 'b.md', content: 'beta' },
      { relPath: 'a.md', content: 'alpha' },
    ]
    const b: DocEntry[] = [
      { relPath: 'a.md', content: 'alpha' },
      { relPath: 'b.md', content: 'beta' },
    ]
    expect(computeDocsHash(a)).toBe(computeDocsHash(b))
  })

  it('changes when any content byte changes', () => {
    const base = computeDocsHash([{ relPath: 'a.md', content: 'alpha' }])
    const edited = computeDocsHash([{ relPath: 'a.md', content: 'alphaa' }])
    expect(edited).not.toBe(base)
  })

  it('changes when a path changes', () => {
    const base = computeDocsHash([{ relPath: 'a.md', content: 'alpha' }])
    const renamed = computeDocsHash([{ relPath: 'b.md', content: 'alpha' }])
    expect(renamed).not.toBe(base)
  })

  it('does not collide when content is shifted across the boundary', () => {
    // Without a delimiter, {a.md:"x", b.md:"y"} and {a.md:"xy", b.md:""} could
    // hash the same. The NUL separators prevent that.
    const left = computeDocsHash([
      { relPath: 'a.md', content: 'x' },
      { relPath: 'b.md', content: 'y' },
    ])
    const right = computeDocsHash([
      { relPath: 'a.md', content: 'xy' },
      { relPath: 'b.md', content: '' },
    ])
    expect(left).not.toBe(right)
  })

  it('empty collection has a stable hash', () => {
    expect(computeDocsHash([])).toBe(computeDocsHash([]))
  })
})

describe('isGeneratedDoc', () => {
  it('flags generated _prd- artifacts', () => {
    expect(isGeneratedDoc('_prd-summary.md')).toBe(true)
    expect(isGeneratedDoc('_prd-summary.json')).toBe(true)
    expect(isGeneratedDoc('spec.md')).toBe(false)
  })
})

describe('readDocsCollection', () => {
  it('reads source .md files and excludes generated artifacts', () => {
    writeDoc('spec.md', '# Spec')
    writeDoc('notes.md', 'notes')
    writeDoc('_prd-summary.md', 'generated')
    writeDoc('_prd-summary.json', '{}')
    writeDoc('diagram.png', 'binary-ish')

    const collection = readDocsCollection(featureDir)
    expect(collection.entries.map((e) => e.relPath)).toEqual(['notes.md', 'spec.md'])
    expect(collection.docsHash).toHaveLength(64)
  })

  it('missing docs dir yields an empty, stable collection', () => {
    const bare = path.join(tmpDir, 'no-docs')
    fs.mkdirSync(bare)
    const collection = readDocsCollection(bare)
    expect(collection.entries).toEqual([])
    expect(collection.docsHash).toBe(computeDocsHash([]))
  })

  it('re-reading the same docs produces the same hash (drift in-sync)', () => {
    writeDoc('spec.md', '# Spec\n\nbody')
    const first = readDocsCollection(featureDir).docsHash
    const second = readDocsCollection(featureDir).docsHash
    expect(second).toBe(first)
  })

  it('editing a doc changes the hash (drift detected)', () => {
    writeDoc('spec.md', '# Spec')
    const before = readDocsCollection(featureDir).docsHash
    writeDoc('spec.md', '# Spec changed')
    const after = readDocsCollection(featureDir).docsHash
    expect(after).not.toBe(before)
  })

  it('skips entries whose name ends in .md but are directories (line 48 branch)', () => {
    // A directory named "test.md" passes the .md check but fails isFile() → continue.
    fs.mkdirSync(path.join(featureDir, 'docs', 'test.md'))
    writeDoc('real.md', 'real content')
    const collection = readDocsCollection(featureDir)
    expect(collection.entries.map((e) => e.relPath)).toEqual(['real.md'])
  })
})
