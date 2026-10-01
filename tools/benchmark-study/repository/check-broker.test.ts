import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { json, write } from '../files'
import type { Attempt, StudyManifest } from '../types'
import { startRepositoryCheckBroker } from './check-broker'
import { verifyCandidateSource, type CandidateReceipt, evaluateRepositoryCandidate } from './candidate'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-broker-'))); roots.push(root)
  const attempt: Attempt = { id: 'codex-overlap-1-canary', agent: 'codex', workflow: 'canary', scenario: 'overlap', repetition: 1 }
  const work = path.join(root, 'attempts', attempt.id)
  const baseline = path.join(root, 'attempts/overlap/source')
  for (const directory of [path.join(work, 'app'), baseline]) {
    write(path.join(directory, 'src/library.ts'), 'broken')
    write(path.join(directory, 'package.json'), '{}')
    write(path.join(directory, 'yarn.lock'), 'frozen')
  }
  const manifest = { root, repository: { maxChecks: 1, yarnCacheFolder: path.join(root, 'cache') } } as StudyManifest
  const receipt: CandidateReceipt = { schemaVersion: 2, scenario: 'overlap',
    candidateDigest: verifyCandidateSource(path.join(work, 'app'), baseline).digest, changedSourceFiles: [], status: 'passed', code: 0,
    roster: ['first', 'second'], passed: ['first', 'second'], failed: [], skipped: [], containerImage: 'synthetic',
    containerState: 'synthetic', containerRecovery: 'synthetic', evidence: 'evaluation/synthetic/playwright.json' }
  json(path.join(root, receipt.evidence), { specs: [{ title: 'first', tests: [{ results: [{ status: 'passed' }] }] }] })
  return { manifest, attempt, work, receipt }
}
function headers(work: string): { authorization: string } {
  const script = fs.readFileSync(path.join(work, 'check.cjs'), 'utf8')
  return { authorization: JSON.parse(script.match(/authorization:("(?:[^"\\]|\\.)*")/)![1]) }
}

it('returns a persistent job promptly, binds its candidate, refuses concurrent checks, and reports stale evidence', async () => {
  const { manifest, attempt, work, receipt } = fixture()
  let release!: (value: CandidateReceipt) => void
  const evaluate = vi.fn<typeof evaluateRepositoryCandidate>(() => new Promise((resolve) => { release = resolve }))
  const broker = await startRepositoryCheckBroker(manifest, attempt, work, new AbortController().signal, evaluate)
  try {
    expect((await fetch(broker.url, { method: 'POST' })).status).toBe(403)
    const auth = headers(work)
    const start = await fetch(broker.url, { method: 'POST', headers: auth, body: JSON.stringify({ candidate: '/unrelated-source', scenario: 'clean' }) })
    expect(start.status).toBe(202)
    const job = await start.json()
    expect(job.status).toBe('running')
    const recovered = await (await fetch(broker.url.replace('/check', '/checks'), { headers: auth })).json()
    expect(recovered).toMatchObject([{ checkId: job.checkId, status: 'running' }])
    expect(JSON.parse(fs.readFileSync(path.join(manifest.root, 'receipts', `${job.checkId}.json`), 'utf8')).status).toBe('running')
    expect(evaluate.mock.calls[0][0]).toMatchObject({ scenario: 'overlap', candidate: path.join(work, 'app'),
      campaign: { attemptId: attempt.id, evaluationId: job.checkId } })
    expect((await fetch(broker.url, { method: 'POST', headers: auth })).status).toBe(409)
    const statusUrl = broker.url.replace('/check', `/checks/${job.checkId}`)
    expect((await (await fetch(statusUrl, { headers: auth })).json()).status).toBe('running')
    write(path.join(work, 'app/src/library.ts'), 'newer source')
    release(receipt)
    await expect.poll(async () => (await (await fetch(statusUrl, { headers: auth })).json()).status).toBe('passed')
    expect((await (await fetch(statusUrl, { headers: auth })).json()).fresh).toBe(false)
    expect((await fetch(broker.url, { method: 'POST', headers: auth })).status).toBe(429)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(broker.executions()).toBe(1)
  } finally { release?.(receipt); await broker.close() }
})

it('keeps evaluator errors invalid and stops new checks without turning missing evidence into test passes', async () => {
  const { manifest, attempt, work } = fixture()
  const evaluate = vi.fn<typeof evaluateRepositoryCandidate>().mockRejectedValue(new Error('Synthetic Docker failure'))
  const broker = await startRepositoryCheckBroker(manifest, attempt, work, new AbortController().signal, evaluate)
  try {
    const auth = headers(work)
    const start = await (await fetch(broker.url, { method: 'POST', headers: auth })).json()
    const statusUrl = broker.url.replace('/check', `/checks/${start.checkId}`)
    await expect.poll(async () => (await (await fetch(statusUrl, { headers: auth })).json()).status).toBe('invalid')
    expect(broker.failure()).toContain('Synthetic Docker failure')
    expect(broker.executions()).toBeNull()
    expect((await fetch(broker.url, { method: 'POST', headers: auth })).status).toBe(503)
  } finally { await broker.close() }
})
