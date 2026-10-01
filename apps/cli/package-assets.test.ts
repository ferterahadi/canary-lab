import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'
import { resolveFirstExisting, resolvePackageAsset } from './package-assets'

const temp = trackTempDirs('cl-package-assets-')

describe('package assets', () => {
  it.each(['apps/cli', 'dist/apps/cli'])('finds templates from %s independently of cwd', (layout) => {
    const root = temp()
    const templates = path.join(root, 'templates/project')
    fs.mkdirSync(templates, { recursive: true })
    expect(resolvePackageAsset('templates/project', path.join(root, layout))).toBe(templates)
  })

  it('prefers the closer candidate when both layouts exist', () => {
    const root = temp()
    const closer = path.join(root, 'dist/templates/project')
    fs.mkdirSync(closer, { recursive: true })
    fs.mkdirSync(path.join(root, 'templates/project'), { recursive: true })
    expect(resolvePackageAsset('templates/project', path.join(root, 'dist/apps/cli'))).toBe(closer)
  })

  it('reports every candidate when no asset is present', () => {
    const root = temp()
    const paths = [path.join(root, 'missing-a'), path.join(root, 'missing-b')]
    expect(() => resolveFirstExisting(paths)).toThrow(`Could not resolve any expected path: ${paths.join(', ')}`)
  })
})
