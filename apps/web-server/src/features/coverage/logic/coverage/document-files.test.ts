import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'
import { documentCandidates, docsDirFor, inspectDocumentFile } from './document-files'
import { computeDocsHash, readDocsCollection } from './docs-collection'
import { listFeatureDocs } from './feature-docs'
import { unreadableSourceDocs } from './freshness'

const temp = trackTempDirs('document-files-')
afterEach(() => vi.restoreAllMocks())

function fixture() {
  const featuresDir = temp()
  const featureDir = path.join(featuresDir, 'example')
  const dir = docsDirFor(featureDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'example', envs: [], repos: [], featureDir: __dirname } }`)
  return { featuresDir, featureDir, dir }
}

it('keeps extension, generated-document, and enumeration-order policies explicit', () => {
  const { dir } = fixture()
  for (const name of ['z.TXT', 'a.MD', 'b.Markdown', '_prd-summary.md', 'image.png']) fs.writeFileSync(path.join(dir, name), name)
  const actual = fs.readdirSync(dir)
  const order = [...actual].reverse()
  vi.spyOn(fs, 'readdirSync').mockReturnValue(order as never)
  expect(documentCandidates(dir, { includeGenerated: true, order: 'filesystem' })).toEqual(order.filter((name) => name !== 'image.png'))
  expect(documentCandidates(dir, { includeGenerated: false, order: 'sorted' })).toEqual(['a.MD', 'b.Markdown', 'z.TXT'])
})

it('returns no candidates for missing directories and propagates enumeration failures', () => {
  const dir = temp()
  expect(documentCandidates(path.join(dir, 'absent'), { includeGenerated: true, order: 'sorted' })).toEqual([])
  const error = new Error('enumeration denied')
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw error })
  expect(() => documentCandidates(dir, { includeGenerated: true, order: 'sorted' })).toThrow(error)
})

it('retains broken links in listing while collection skips them and freshness rejects them', () => {
  const { featuresDir, featureDir, dir } = fixture()
  const target = path.join(temp(), 'target.txt')
  fs.writeFileSync(target, 'Source café')
  fs.symlinkSync(target, path.join(dir, 'linked.md'))
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken.md'))
  fs.mkdirSync(path.join(dir, 'nested.md'))
  fs.writeFileSync(path.join(dir, 'nested.md', 'ignored.md'), 'nested')
  fs.writeFileSync(path.join(dir, '_prd-other.md'), 'generated')
  const entries = [{ relPath: 'linked.md', content: 'Source café' }]
  expect(readDocsCollection(featureDir)).toMatchObject({ entries, docsHash: computeDocsHash(entries) })
  expect(unreadableSourceDocs(featureDir)).toEqual(['broken.md'])
  const listing = listFeatureDocs(featuresDir, 'example')
  expect(listing.docs.map((doc) => doc.relPath)).toEqual(['_prd-other.md', 'broken.md', 'linked.md'])
  expect(listing.docs[0]).not.toHaveProperty('linked')
  expect(listing.docs[1]).toMatchObject({ linked: true, broken: true, sizeBytes: 0 })
  expect(listing.docs[2]).toMatchObject({ linked: true, linkTarget: target, sizeBytes: Buffer.byteLength('Source café') })
  expect(listing.docs[2]).not.toHaveProperty('broken')
  expect(listing.sourceDocCount).toBe(2)
})

it('can inspect metadata without reading and distinguishes read and stat failures', () => {
  const { dir } = fixture()
  const file = path.join(dir, 'source.md')
  fs.writeFileSync(file, 'source')
  const error = Object.assign(new Error('denied'), { code: 'EACCES' })
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw error })
  expect(inspectDocumentFile(file, false)).toMatchObject({ kind: 'file', content: undefined, stat: { size: 6 } })
  expect(inspectDocumentFile(file, true)).toEqual({ kind: 'unreadable' })
  expect(inspectDocumentFile(path.join(dir, 'absent'), false)).toEqual({ kind: 'unreadable' })
  expect(inspectDocumentFile(dir, true)).toEqual({ kind: 'non-file' })
})

it('preserves listing lstat failures instead of silently dropping a raced-away entry', () => {
  const { featuresDir, dir } = fixture()
  const file = path.join(dir, 'source.md')
  fs.writeFileSync(file, 'source')
  const original = fs.lstatSync
  const error = new Error('entry disappeared')
  vi.spyOn(fs, 'lstatSync').mockImplementation(((input: fs.PathLike, ...args: []) => {
    if (String(input) === file) throw error
    return original(input, ...args)
  }) as typeof fs.lstatSync)
  expect(() => listFeatureDocs(featuresDir, 'example')).toThrow(error)
})

it('keeps excluded originals readable and expires exclusions when their contents change', async () => {
  const { documentHash, writeDocumentSelection } = await import('./document-resolution')
  const { featureDir, dir } = fixture()
  fs.writeFileSync(path.join(dir, 'rejected.md'), 'original')
  fs.writeFileSync(path.join(dir, 'selected.md'), 'selected')
  writeDocumentSelection(featureDir, { reviewedDocsHash: 'review', decisionKey: 'choice', sources: [], searched: [], excluded: [{ relPath: 'rejected.md', sha256: documentHash('original') }] })
  expect(readDocsCollection(featureDir).entries.map((e) => e.relPath)).toEqual(['selected.md'])
  expect(readDocsCollection(featureDir, { includeExcluded: true }).entries.map((e) => e.relPath)).toEqual(['rejected.md', 'selected.md'])
  expect(unreadableSourceDocs(featureDir)).toEqual([])
  fs.writeFileSync(path.join(dir, 'rejected.md'), 'revised')
  expect(readDocsCollection(featureDir).entries.map((e) => e.relPath)).toEqual(['rejected.md', 'selected.md'])
})
