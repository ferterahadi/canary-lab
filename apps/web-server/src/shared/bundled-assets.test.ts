import { describe, expect, it } from 'vitest'
import path from 'path'
import { ASSETS_DIR, readBundledAsset } from './bundled-assets'

describe('bundled assets', () => {
  it('resolves the checked-in assets directory and reads a shipped file', () => {
    expect(ASSETS_DIR).toBe(path.resolve(__dirname, '../../assets'))
    expect(readBundledAsset('verify-certificate.mjs')).toContain('behavior-certificate@2')
  })

  it('names the missing path so a broken install is diagnosable', () => {
    expect(() => readBundledAsset('no-such-asset.txt')).toThrow(/no-such-asset\.txt.*Rebuild or reinstall/)
  })
})
