import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { claimedSingleAttempt, policyForRunManifest, validateSingleAttempt } from './single-attempt'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-legacy-attempt-')

describe('suite single-attempt receipt', () => {
  it('selects and reloads legacy policies by existence, without falling back past invalid configuration', () => {
    const root = tempDir('cl-legacy-order-')
    const featureDir = path.join(root, 'demo')
    fs.mkdirSync(featureDir)
    const manifest = { feature: 'demo', featureDir }
    for (const format of ['ts', 'js', 'cjs']) {
      fs.writeFileSync(path.join(featureDir, `feature.config.${format}`),
        `exports.config = { name: 'demo', singleAttempt: { receipt: '${format}.json' } }`)
    }
    for (const format of ['cjs', 'js', 'ts']) {
      const file = path.join(featureDir, `feature.config.${format}`)
      expect(policyForRunManifest(manifest)).toEqual({ receipt: `${format}.json` })
      fs.writeFileSync(file, "exports.config = { name: 'demo', singleAttempt: { receipt: 'rewritten.json' } }")
      expect(policyForRunManifest(manifest)).toEqual({ receipt: 'rewritten.json' })
      fs.writeFileSync(file, 'throw new Error("invalid first candidate")')
      expect(policyForRunManifest(manifest)).toBeUndefined()
      fs.unlinkSync(file)
    }
    expect(policyForRunManifest(manifest)).toBeUndefined()
  })

  it('accepts a run-relative receipt and observes the suite claim', () => {
    const runDir = tempDir('cl-attempt-')
    const policy = { receipt: 'runtime/effect-attempt/attempt.json' }
    expect(claimedSingleAttempt(runDir, policy)).toBe(false)
    const receipt = path.join(runDir, policy.receipt)
    fs.mkdirSync(path.dirname(receipt), { recursive: true })
    fs.writeFileSync(receipt, '{}')
    expect(claimedSingleAttempt(runDir, policy)).toBe(true)
  })

  it.each(['../outside', '/absolute/attempt.json', 'runtime//attempt.json', 'runtime/./attempt.json'])(
    'rejects a receipt outside a canonical run-relative path: %s',
    (receipt) => expect(() => validateSingleAttempt({ receipt })).toThrow('singleAttempt.receipt'),
  )

  it('uses the named suite config for runs created before the policy field existed', () => {
    const root = tempDir()
    const featureDir = path.join(root, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'),
      "module.exports = { config: { name: 'demo', singleAttempt: { receipt: 'runtime/attempt.json' } } }\n")

    expect(policyForRunManifest({ feature: 'demo', featureDir })).toEqual({ receipt: 'runtime/attempt.json' })
    expect(policyForRunManifest({ feature: 'other', featureDir })).toBeUndefined()
    expect(policyForRunManifest({ feature: 'demo', featureDir, singleAttempt: { receipt: 'pinned.json' } }))
      .toEqual({ receipt: 'pinned.json' })
  })

  it('does not infer a legacy policy from a missing or malformed suite config', () => {
    const root = tempDir()
    const featureDir = path.join(root, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    expect(policyForRunManifest({ feature: 'demo' })).toBeUndefined()
    expect(policyForRunManifest({ feature: 'demo', featureDir })).toBeUndefined()

    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'other' } }\n")
    expect(policyForRunManifest({ feature: 'demo', featureDir })).toBeUndefined()

    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'throw new Error("broken config")\n')
    expect(policyForRunManifest({ feature: 'demo', featureDir })).toBeUndefined()

    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports.default = { name: 'demo', singleAttempt: { receipt: 'default.json' } }\n")
    expect(policyForRunManifest({ feature: 'demo', featureDir })).toEqual({ receipt: 'default.json' })
  })
})
