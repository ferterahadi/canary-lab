import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claimedSingleAttempt, policyForRunManifest, validateSingleAttempt } from './single-attempt'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('suite single-attempt receipt', () => {
  it('accepts a run-relative receipt and observes the suite claim', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-attempt-'))
    dirs.push(runDir)
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-legacy-attempt-'))
    dirs.push(root)
    const featureDir = path.join(root, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'),
      "module.exports = { config: { name: 'demo', singleAttempt: { receipt: 'runtime/attempt.json' } } }\n")

    expect(policyForRunManifest({ feature: 'demo', featureDir })).toEqual({ receipt: 'runtime/attempt.json' })
    expect(policyForRunManifest({ feature: 'other', featureDir })).toBeUndefined()
    expect(policyForRunManifest({ feature: 'demo', featureDir, singleAttempt: { receipt: 'pinned.json' } }))
      .toEqual({ receipt: 'pinned.json' })
  })
})
