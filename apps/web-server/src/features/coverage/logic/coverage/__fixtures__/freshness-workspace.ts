import fs from 'fs'
import os from 'os'
import path from 'path'
import { regeneratePrdSummary, runCoverageEngine } from '../service'
import { fakePropose, fakeSummarize } from './fake-coverage-agents'

export async function freshnessWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-freshness-')))
  const feature = 'shop'
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  const featureDir = path.join(featuresDir, feature)
  const doc = path.join(root, 'requirements.md')
  const spec = path.join(featureDir, 'e2e', 'shop.spec.ts')
  fs.mkdirSync(path.dirname(spec), { recursive: true })
  fs.mkdirSync(path.join(featureDir, 'docs'))
  fs.mkdirSync(logsDir)
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'shop', description: 'shop', envs: ['local'], featureDir: __dirname } }`)
  fs.writeFileSync(doc, '# Create order\nA buyer can create an order.')
  fs.symlinkSync(doc, path.join(featureDir, 'docs', 'requirements.md'))
  fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'\ntest('create order', async () => { expect(1).toBe(1) })\n`)
  const args = { featuresDir, logsDir, feature }
  await regeneratePrdSummary({ ...args, now: '2026-09-01T00:00:00Z' }, { summarize: fakeSummarize })
  await runCoverageEngine({ ...args, now: '2026-09-01T00:00:00Z' }, { propose: fakePropose })
  const runs: Array<{ runId: string; feature: string; startedAt: string; status: 'passed' | 'failed' | 'running' }> = []
  const run = (runId: string, status: 'passed' | 'failed' | 'running', summary = true) => {
    const dir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(dir, { recursive: true })
    const entry = { runId, feature, startedAt: `2026-09-17T00:00:0${runs.length}Z`, endedAt: `2026-09-17T00:00:0${runs.length}Z`, status }
    runs.push(entry)
    fs.writeFileSync(path.join(logsDir, 'runs', 'index.json'), JSON.stringify(runs))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(entry))
    if (summary) fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify({
      passedNames: status === 'passed' ? ['test-case-create-order'] : [],
      failed: status === 'failed' ? [{ name: 'test-case-create-order' }] : [],
    }))
  }
  return { root, featureDir, doc, spec, args, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
