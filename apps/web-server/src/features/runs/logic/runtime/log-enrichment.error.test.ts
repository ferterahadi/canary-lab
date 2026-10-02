import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'
import { enrichSummaryWithLogs } from './log-enrichment'

const makeTemp = trackTempDirs('canary-error-evidence-')
afterEach(() => vi.unstubAllEnvs())

it('persists full assertion error evidence even without any service logs', () => {
  const dir = makeTemp()
  const summaryPath = path.join(dir, 'e2e-summary.json')
  const error = { message: 'Expected checkout to succeed\n'.repeat(100), snippet: 'expect(response.ok()).toBe(true)' }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ feature: 'checkout' }))
  fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'checkout', error }] }))
  vi.stubEnv('CANARY_LAB_SUMMARY_PATH', summaryPath)
  const result = enrichSummaryWithLogs()
  expect(result?.summary.failed?.[0].errorFile).toBeTruthy()
  expect(JSON.parse(fs.readFileSync(summaryPath, 'utf-8')).failed[0].errorFile).toBe(result?.summary.failed?.[0].errorFile)
  const evidence = fs.readFileSync(path.join(dir, 'failed/checkout/error.txt'), 'utf-8')
  expect(evidence).toContain(error.message.trim())
  expect(evidence).toContain(error.snippet)
})
