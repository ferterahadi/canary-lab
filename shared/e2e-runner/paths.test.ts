import { describe, it, expect, afterEach } from 'vitest'
import { getSummaryPath, SUMMARY_PATH } from './paths'

const original = process.env.CANARY_LAB_SUMMARY_PATH

afterEach(() => {
  if (original === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
  else process.env.CANARY_LAB_SUMMARY_PATH = original
})

describe('getSummaryPath', () => {
  it('returns SUMMARY_PATH by default', () => {
    delete process.env.CANARY_LAB_SUMMARY_PATH
    expect(getSummaryPath()).toBe(SUMMARY_PATH)
  })

  it('honors CANARY_LAB_SUMMARY_PATH override', () => {
    process.env.CANARY_LAB_SUMMARY_PATH = '/tmp/custom-summary.json'
    expect(getSummaryPath()).toBe('/tmp/custom-summary.json')
  })
})
