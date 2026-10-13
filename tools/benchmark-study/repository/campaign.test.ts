import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { digest, json, sha, write } from '../files'
import { schedule } from '../scenarios'
import { configurationDigest, policyDigests } from '../experiment'
import { loadStudy, runStudy } from '../study'
import type { StudyManifest } from '../types'
import { repositoryStudyAdapter, assertRepositoryAuthorization, verifyRepositoryContinuation } from './campaign'
import { repositoryCacheDigest, repositoryCacheEntries } from './dependencies'
import { assertRepositoryWorkerOwner } from './worker-owner'
import { studyStatus } from '../study-status'
import { writeRepositoryFailureContext } from './failure-context'
import { trackTempDirs } from '../../test-helpers/temp-dir'

const tempDir = trackTempDirs('repository-campaign-')
afterEach(() => { vi.restoreAllMocks() })
function fixture(live = false): StudyManifest {
  const root = tempDir()
  for (const scenario of ['overlap', 'independent']) {
    for (const prefix of ['frozen', 'attempts']) {
      const directory = path.join(root, prefix, scenario, ...(prefix === 'attempts' ? ['source'] : []))
      write(path.join(directory, 'src/library.ts'), 'broken\n')
      write(path.join(directory, 'package.json'), '{}\n')
      write(path.join(directory, 'yarn.lock'), 'frozen\n')
    }
  }
  const design = { mode: live ? 'live' as const : 'replay' as const, repetitions: 2, seed: 91,
    ...(live ? { variants: [{ id: 'per-failure', diagnosisPolicy: 'per-failure' as const }, { id: 'parent-only', diagnosisPolicy: 'parent-only' as const }] } : {}) }
  for (const scenario of ['overlap', 'independent']) writeRepositoryFailureContext(path.join(root, 'frozen/diagnosis/codex', scenario),
    [{ title: 'first', messages: ['First failure'] }, { title: 'second', messages: ['Second failure'] }], 'codex',
    { model: 'synthetic-model', effort: 'high', version: 'synthetic' })
  const manifest: StudyManifest = { schemaVersion: 1, root, status: 'ready', createdAt: new Date().toISOString(), sourceWorkspace: root,
    sourceRevision: 'synthetic', sourceDigest: '', dependencyDigest: '', dependencyVersions: {}, preparation: {}, preparationMs: 0,
    pins: { codex: { model: 'synthetic-model', effort: 'high', version: 'synthetic' }, claude: { model: 'synthetic-model', effort: 'high', version: 'synthetic' } },
    budgetMs: 900_000, snapshots: {}, frozenDigest: digest(path.join(root, 'frozen')), results: [], active: null,
    design, selection: { agent: 'codex' }, attempts: schedule({ agent: 'codex' }, design, ['overlap', 'independent']),
    repository: { kind: 'unfamiliar-repository-campaign', localManifestDigest: '', sourceCommit: 'a'.repeat(40), sourceCheckout: root,
      fixtureRoot: root, yarnCacheFolder: root, yarnCacheDigest: '', yarnCacheEntries: [], expectedRoster: ['first', 'second'], maxChecks: 2, authorizationRequired: true } }
  manifest.experiment = { configurationDigest: '', maxTokens: 100, promptDigests: policyDigests(manifest) }
  manifest.experiment.configurationDigest = configurationDigest(manifest)
  json(path.join(root, 'study.json'), manifest)
  return manifest
}
function approve(manifest: StudyManifest): void {
  json(path.join(manifest.root, 'source-transfer-approval.json'), { configurationDigest: manifest.experiment!.configurationDigest,
    sourceTransfer: true, paidExecution: true, approvedAt: '2026-01-01T00:00:00Z' })
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

it('continues only unassigned slots, preserving a failed result and its spent tokens', () => {
  const previous = fixture(true)
  previous.results = previous.attempts.slice(0, 3).map((attempt, index) => ({ ...attempt, outcome: index === 2 ? 'infrastructure-error' : 'success',
    startedAt: previous.createdAt, repairMs: 1, verificationMs: 0, usage: { ...usage, input: 10 }, testExecutions: 0,
    humanInterventions: 0, changedFiles: [], reason: 'Recorded original outcome', evidence: 'synthetic' }))
  json(path.join(previous.root, 'study.json'), previous)
  const selection = { agent: 'codex' as const, continuation: { sourceStudy: previous.root,
    sourceManifestSha256: sha(fs.readFileSync(path.join(previous.root, 'study.json'))), recordedAttemptIds: previous.results.map((row) => row.id) } }
  expect(schedule(selection, previous.design, ['overlap', 'independent'])).toEqual(previous.attempts.slice(3))
  expect(() => verifyRepositoryContinuation(selection, previous.design!, previous.repository!.sourceCommit, previous.pins, 70)).not.toThrow()
  expect(() => verifyRepositoryContinuation(selection, previous.design!, previous.repository!.sourceCommit, previous.pins, 71)).toThrow('token allowance')
  expect(() => verifyRepositoryContinuation(selection, previous.design!, previous.repository!.sourceCommit,
    { ...previous.pins, codex: { ...previous.pins.codex, model: 'changed-model' } }, 70)).toThrow('retain')
  expect(() => schedule({ ...selection, continuation: { ...selection.continuation, recordedAttemptIds: [previous.attempts[1].id] } },
    previous.design, ['overlap', 'independent'])).toThrow('recorded prefix')
  previous.results[2].usage = null
  json(path.join(previous.root, 'study.json'), previous)
  expect(() => verifyRepositoryContinuation(selection, previous.design!, previous.repository!.sourceCommit, previous.pins, 70)).toThrow('manifest changed')
  selection.continuation.sourceManifestSha256 = sha(fs.readFileSync(path.join(previous.root, 'study.json')))
  expect(() => verifyRepositoryContinuation(selection, previous.design!, previous.repository!.sourceCommit, previous.pins, 70)).toThrow('unknown usage')
})

it('blocks unapproved live campaigns before any dispatch, even with test fingerprint checks disabled', async () => {
  const manifest = fixture(true)
  const execute = vi.fn()
  await expect(runStudy(manifest.root, { execute, checkFingerprints: false })).rejects.toThrow('not approved')
  expect(execute).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(manifest.root, 'study.lock'))).toBe(false)
  approve(manifest)
  manifest.pins.codex.model = 'another-model'
  expect(() => assertRepositoryAuthorization(manifest)).toThrow('configuration')
  json(path.join(manifest.root, 'study.json'), manifest)
  expect(() => loadStudy(manifest.root)).toThrow('configuration')
})

it('shares cumulative checkpoints and resumes the next fresh repository attempt with distinct receipts', async () => {
  const manifest = fixture()
  const verify = vi.spyOn(repositoryStudyAdapter, 'verify').mockResolvedValue({ success: true, evidence: 'synthetic-oracle' })
  const execute = vi.fn(async (_manifest, _attempt, root: string) => {
    write(path.join(root, 'app/src/library.ts'), 'fixed\n')
    return { status: 'finished' as const, reason: 'Synthetic dispatch', usage, testExecutions: 2 }
  })
  const first = await runStudy(manifest.root, { execute, stopAfter: 2, checkFingerprints: false })
  expect(first.results).toHaveLength(2)
  expect(first.results.every((result) => result.outcome === 'success')).toBe(true)
  expect(first.results.every((result) => result.changedFiles.includes('src/library.ts'))).toBe(true)
  await runStudy(manifest.root, { execute, resume: true, stopAfter: 2, checkFingerprints: false })
  expect(execute).toHaveBeenCalledTimes(2)
  const resumed = await runStudy(manifest.root, { execute, resume: true, stopAfter: 3, checkFingerprints: false })
  expect(resumed.results).toHaveLength(3)
  expect(verify).toHaveBeenCalledTimes(3)
  for (const result of resumed.results) {
    expect(fs.existsSync(path.join(manifest.root, 'receipts', `${result.id}.json`))).toBe(true)
    expect(fs.readFileSync(path.join(manifest.root, 'receipts', `${result.id}.patch`), 'utf8')).toContain('fixed')
    expect(result.timing!.independentVerdictMs).toBeGreaterThanOrEqual(0)
  }
  const report = JSON.parse(fs.readFileSync(path.join(manifest.root, 'report.json'), 'utf8'))
  expect(report.summary.map((group: { scenario: string }) => group.scenario).sort()).toEqual(['independent', 'overlap'])
})

it.each(['timeout', 'interrupted', 'infrastructure-error'] as const)('preserves %s and stops later dispatch, including resume', async (status) => {
  const manifest = fixture()
  const execute = vi.fn().mockResolvedValue({ status, reason: 'Synthetic stop', usage, testExecutions: 0 })
  const result = await runStudy(manifest.root, { execute, checkFingerprints: false })
  expect(result.results).toHaveLength(1)
  expect(result.results[0].outcome).toBe(status)
  await runStudy(manifest.root, { execute, resume: true, checkFingerprints: false })
  expect(execute).toHaveBeenCalledTimes(1)
})

it.each([null, { ...usage, input: 100 }])('stops live dispatch when native usage is unknown or at its ceiling (%j)', async (observed) => {
  const manifest = fixture(true); approve(manifest)
  vi.spyOn(repositoryStudyAdapter, 'verify').mockResolvedValue({ success: true, evidence: 'synthetic-oracle' })
  const execute = vi.fn().mockResolvedValue({ status: 'finished', reason: 'Synthetic dispatch', usage: observed, testExecutions: 1 })
  const result = await runStudy(manifest.root, { execute, checkFingerprints: false })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(result.stopReason).toContain(observed === null ? 'Usage unknown' : 'ceiling')
})

it('marks frozen metadata edits as contamination before independent verification', async () => {
  const manifest = fixture()
  const verify = vi.spyOn(repositoryStudyAdapter, 'verify')
  const result = await runStudy(manifest.root, { checkFingerprints: false, execute: async (_m, _a, root) => {
    write(path.join(root, 'app/package.json'), '{"unsafe":true}')
    return { status: 'finished', reason: 'Synthetic edit', usage, testExecutions: 0 }
  } })
  expect(result.results[0].outcome).toBe('contaminated')
  expect(verify).not.toHaveBeenCalled()
})

it('stops on a known diagnosis context violation while preserving the successful independent repair verdict and native usage', async () => {
  const manifest = fixture(true); approve(manifest)
  const verify = vi.spyOn(repositoryStudyAdapter, 'verify').mockResolvedValue({ success: true, evidence: 'synthetic-oracle' })
  const execute = vi.fn().mockResolvedValue({ status: 'finished', reason: 'Synthetic dispatch', usage: { ...usage, input: 17 }, testExecutions: 1,
    adherence: { assigned: 'per-failure', status: 'violation', childCount: 2, reviewRequired: true, evidence: ['Full parent history inherited'] } })
  const result = await runStudy(manifest.root, { execute, checkFingerprints: false })
  expect(result.results).toHaveLength(1)
  expect(result.results[0]).toMatchObject({ outcome: 'success', usage: { input: 17 }, adherence: { status: 'violation' } })
  expect(result.stopReason).toContain('diagnosis policy violation')
  expect(verify).toHaveBeenCalledTimes(1)
  await runStudy(manifest.root, { execute, resume: true, checkFingerprints: false })
  expect(execute).toHaveBeenCalledTimes(1)
})

it('protects generated failure slices while allowing the parent to update its ledger', async () => {
  const manifest = fixture()
  const attempt = manifest.attempts[0]
  const root = path.join(manifest.root, 'attempts', attempt.id)
  await repositoryStudyAdapter.setup(manifest, attempt, root)
  json(path.join(root, 'diagnosis-ledger.json'), { failures: [{ status: 'addressed' }] })
  expect(repositoryStudyAdapter.integrity(manifest, attempt, root).contamination).toEqual([])
  write(path.join(root, 'heal-index.md'), 'Rewritten by the agent')
  expect(repositoryStudyAdapter.integrity(manifest, attempt, root).contamination.join(' ')).toContain('Protected failure context changed')
})

it('preserves an unfinished attempt as interrupted instead of rerunning its candidate on resume', async () => {
  const manifest = fixture()
  manifest.active = { attempt: manifest.attempts[0], startedAt: '2026-01-01T00:00:00Z' }
  const checkFile = path.join(manifest.root, 'receipts', `${manifest.active.attempt.id}-check-1.json`)
  json(checkFile, { status: 'running', startedAt: manifest.active.startedAt })
  json(path.join(manifest.root, 'study.json'), manifest)
  const execute = vi.fn()
  const result = await runStudy(manifest.root, { resume: true, execute, checkFingerprints: false })
  expect(result.results[0]).toMatchObject({ outcome: 'interrupted', repairMs: null, usage: null })
  expect(result.active).toBeNull()
  expect(execute).not.toHaveBeenCalled()
  expect(JSON.parse(fs.readFileSync(checkFile, 'utf8'))).toMatchObject({ status: 'interrupted' })
})

it('retains native worker usage after the scheduler exits before saving its receipt', async () => {
  const manifest = fixture(true); approve(manifest)
  manifest.active = { attempt: manifest.attempts[0], startedAt: '2026-01-01T00:00:00Z' }
  json(path.join(manifest.root, 'study.json'), manifest)
  json(path.join(manifest.root, 'attempts', manifest.active.attempt.id, 'execution.json'),
    { status: 'finished', usage: { ...usage, input: 53 }, testExecutions: 2 })
  const execute = vi.fn()
  const result = await runStudy(manifest.root, { resume: true, execute, checkFingerprints: false })
  expect(result.results[0]).toMatchObject({ outcome: 'interrupted', usage: { input: 53 }, testExecutions: 2 })
  expect(execute).not.toHaveBeenCalled()
})

it('requires the exact active scheduler parent and its lease before repository dispatch', () => {
  const manifest = fixture()
  const id = manifest.attempts[0].id
  manifest.active = { attempt: manifest.attempts[0], startedAt: new Date().toISOString() }
  json(path.join(manifest.root, 'study.lock'), { pid: 12345 })
  expect(() => assertRepositoryWorkerOwner(manifest, id, true, 12345)).not.toThrow()
  expect(() => assertRepositoryWorkerOwner(manifest, id, false, 12345)).toThrow('owner lease')
  expect(() => assertRepositoryWorkerOwner(manifest, id, true, 12346)).toThrow('owner lease')
  expect(() => assertRepositoryWorkerOwner(manifest, manifest.attempts[1].id, true, 12345)).toThrow('owner lease')
})

it('delivers a new durable revision to a waiting consumer and recovers missed revisions on reconnect', async () => {
  const manifest = fixture()
  const initial = await studyStatus(manifest.root)
  const waiting = studyStatus(manifest.root, { afterRevision: initial.revision, waitMs: 1000 })
  manifest.revision = 3
  manifest.active = { attempt: manifest.attempts[0], startedAt: new Date().toISOString() }
  json(path.join(manifest.root, 'study.json'), manifest)
  expect(await waiting).toMatchObject({ revision: 3, active: { attempt: { id: manifest.attempts[0].id } }, recorded: 0 })
  manifest.revision = 5; manifest.status = 'ready'; manifest.active = null
  manifest.stopReason = 'Synthetic pause'
  json(path.join(manifest.root, 'study.json'), manifest)
  expect(await studyStatus(manifest.root, { afterRevision: 3, waitMs: 1000 })).toMatchObject({ revision: 5, status: 'ready', stopReason: 'Synthetic pause' })
  expect(await studyStatus(manifest.root, { afterRevision: 5, waitMs: 1 })).toMatchObject({ revision: 5 })
  await expect(studyStatus(manifest.root, { waitMs: 60_001 })).rejects.toThrow('Status requires')
})

it('fingerprints only lockfile-selected cache bytes and rejects missing or changed dependencies', () => {
  const root = tempDir('repository-cache-')
  const hash = 'a'.repeat(40)
  const name = `npm-@synthetic-package-1.0.0-${hash}-integrity`
  write(path.join(root, 'v6', name, 'package.js'), 'pinned')
  write(path.join(root, 'v6', 'unrelated', 'package.js'), 'other')
  const lock = path.join(root, 'yarn.lock')
  write(lock, `package@1.0.0:\n  resolved "https://registry.example.invalid/package.tgz#${hash}"\n`)
  const entries = repositoryCacheEntries(root, [lock])
  expect(entries).toEqual([name])
  const before = repositoryCacheDigest(root, entries)
  write(path.join(root, 'v6/unrelated/package.js'), 'changed outside the frozen lockfiles')
  expect(repositoryCacheDigest(root, entries)).toBe(before)
  write(path.join(root, 'v6', name, 'package.js'), 'changed')
  expect(repositoryCacheDigest(root, entries)).not.toBe(before)
  fs.rmSync(path.join(root, 'v6', name), { recursive: true })
  expect(() => repositoryCacheEntries(root, [lock])).toThrow('missing')
})
