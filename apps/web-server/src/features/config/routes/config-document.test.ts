import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { readConfigDocument, resolveConfigDocument, writeConfigDocument } from './config-document'
import { FEATURE_CONFIG_NAMES, type ResolvedConfigPath } from '../../../shared/config-file'
import { readFeatureConfig, writeFeatureConfig } from '../../../shared/config-ast'

const tempDir = trackTempDirs('config-document-')
const original = "module.exports = { config: { name: 'checkout', description: 'Checkout', featureDir: __dirname } }"

function fixture() {
  const dir = tempDir()
  const featureDir = path.join(dir, 'checkout')
  fs.mkdirSync(featureDir)
  const cfg: ResolvedConfigPath = { path: path.join(featureDir, 'feature.config.cjs'), format: 'cjs' }
  fs.writeFileSync(cfg.path, original)
  return { dir, featureDir, cfg }
}

describe('configuration documents', () => {
  it('resolves the existing config and returns the same document shape after a write', () => {
    const { dir, cfg } = fixture()
    expect(resolveConfigDocument(dir, 'checkout', FEATURE_CONFIG_NAMES, 'config file')).toMatchObject({ ok: true, cfg })
    const value = { name: 'checkout', description: 'Updated' }
    const content = writeFeatureConfig(original, value)
    const result = writeConfigDocument(cfg, value, writeFeatureConfig, readFeatureConfig)
    expect(result).toEqual({ ok: true, document: { path: cfg.path, format: 'cjs', content, parsed: readFeatureConfig(content) } })
    expect(fs.readFileSync(cfg.path, 'utf8')).toBe(content)
    expect(readConfigDocument(cfg, readFeatureConfig)).toEqual(result.ok && result.document)
  })

  it('preserves lookup failures for missing suites and configuration files', () => {
    const { dir } = fixture()
    expect(resolveConfigDocument(dir, 'missing', FEATURE_CONFIG_NAMES, 'config file')).toEqual({ ok: false, missing: 'feature' })
    expect(resolveConfigDocument(dir, 'checkout', ['playwright.config.ts'], 'playwright config')).toEqual({ ok: false, missing: 'playwright config' })
  })

  it('reports serialization errors without writing or parsing', () => {
    const { cfg } = fixture()
    const parse = vi.fn(readFeatureConfig)
    expect(writeConfigDocument(cfg, [], writeFeatureConfig, parse)).toMatchObject({ ok: false, error: expect.any(String) })
    expect(fs.readFileSync(cfg.path, 'utf8')).toBe(original)
    expect(parse).not.toHaveBeenCalled()
  })

  it('propagates a read failure before serialization', () => {
    const { cfg } = fixture()
    fs.unlinkSync(cfg.path)
    const serialize = vi.fn(writeFeatureConfig)
    expect(() => writeConfigDocument(cfg, {}, serialize, readFeatureConfig)).toThrow(/ENOENT/)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('propagates write failure without parsing or converting it to a client error', () => {
    const { cfg } = fixture()
    const parse = vi.fn(readFeatureConfig)
    const serialize = () => {
      // Replace the target after its read so the real write fails at the
      // correct boundary without mocking filesystem persistence.
      fs.unlinkSync(cfg.path)
      fs.mkdirSync(cfg.path)
      return 'updated'
    }
    expect(() => writeConfigDocument(cfg, {}, serialize, parse)).toThrow(/EISDIR/)
    expect(parse).not.toHaveBeenCalled()
  })

  it('propagates a parse failure after persisting the serialized content', () => {
    const { cfg } = fixture()
    const error = new Error('parse failed')
    expect(() => writeConfigDocument(cfg, {}, () => 'updated', () => { throw error })).toThrow(error)
    expect(fs.readFileSync(cfg.path, 'utf8')).toBe('updated')
  })
})
