import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freezeToolConfig, sessionEvidence } from './agents'
import { groupUsage, parseUsage, sessionRole } from './usage'
import { canaryRunDir, changed, copy, digest, hashes, json, sourceRoot, write } from './files'
import { buildScenario, plainSuite, schedule } from './scenarios'
import { integrity, loadStudy, runStudy } from './study'
import { parseResults } from './evaluator'
import { report, summarize } from './report'
import type { StudyManifest } from './types'
import { validatePins } from './prepare'
import { configurationDigest, policyDigests } from './experiment'

const roots: string[] = []
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-study-test-')); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(): StudyManifest {
  const root = fs.realpathSync(temp())
  for (const scenario of ['single-service', 'cross-service']) write(path.join(root, 'frozen', scenario, 'checkout-service/server.ts'), 'broken\n')
  for (const mode of ['original', 'plain']) {
    write(path.join(root, `frozen/${mode}-suite/e2e/storefront.spec.ts`), 'protected\n')
    write(path.join(root, `frozen/${mode}-suite/playwright.config.ts`), 'protected config\n')
  }
  fs.mkdirSync(path.join(root, 'runtime/node_modules'), { recursive: true })
  const manifest: StudyManifest = { schemaVersion: 1, status: 'ready', root, sourceWorkspace: root, sourceRevision: 'fixture', sourceDigest: '', dependencyDigest: '', dependencyVersions: {},
    pins: { codex: { model: 'fixture', effort: 'medium', version: 'fixture' }, claude: { model: 'fixture', effort: 'high', version: 'fixture' } },
    createdAt: new Date().toISOString(), budgetMs: 900_000, preparationMs: 0, preparation: {}, snapshots: { 'single-service': '', 'cross-service': '' }, frozenDigest: '',
    attempts: schedule(), results: [], active: null }
  json(path.join(root, 'study.json'), manifest)
  return manifest
}

describe('study protocol', () => {
  it('counts delegated usage separately and leaves missing child usage unknown', () => {
    const tokens = (input: number): string => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 2 } } } })
    const parent = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'child-call' } }) + '\n' + tokens(100)
    expect(groupUsage('codex', [parent])).toBeNull()
    expect(groupUsage('codex', [parent, tokens(25)])).toEqual({ input: 125, output: 4, cacheRead: null, cacheWrite: null })
    expect(groupUsage('codex', [parent, '{}'])).toBeNull()
    const rejected = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'child-call', output: 'collab spawn failed: agent thread limit reached' } })
    expect(groupUsage('codex', [parent + '\n' + rejected])).toEqual({ input: 100, output: 2, cacheRead: null, cacheWrite: null })
    const approval = JSON.stringify({ type: 'session_meta', payload: { thread_source: 'guardian_review' } }) + '\n' + tokens(10)
    expect(groupUsage('codex', [parent, approval])).toBeNull()
    expect(groupUsage('codex', [parent, tokens(25), approval])?.input).toBe(135)
  })
  it('preserves platform approval usage without mistaking its model for the repair model', () => {
    const root = temp(); const logPath = path.join(root, 'approval.jsonl')
    const context = JSON.stringify({ type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } })
    const raw = JSON.stringify({ type: 'session_meta', payload: { thread_source: 'guardian_review' } }) + '\n' + context
    write(logPath, raw)
    expect(sessionRole('codex', raw)).toBe('approval-review')
    expect(sessionRole('codex', context)).toBe('repair')
    const ref = { agent: 'codex' as const, sessionId: 'approval', logPath }
    expect(() => sessionEvidence(ref, path.join(root, 'copied'), { model: 'repair-model', effort: 'high' })).not.toThrow()
    write(logPath, context)
    expect(() => sessionEvidence(ref, path.join(root, 'mismatch'), { model: 'repair-model', effort: 'high' })).toThrow('settings differ')
  })
  it('disables inherited tools before the positional prompt without changing that prompt', () => {
    expect(freezeToolConfig('claude --model pinned -- "@/tmp/prompt.md"', 'claude', { promptFile: '/tmp/prompt.md' })).toBe('claude --model pinned --strict-mcp-config -- "@/tmp/prompt.md"')
    expect(freezeToolConfig('codex --model pinned', 'codex', {}, ['-c', 'mcp_servers.example.enabled=false'])).toBe("codex --model pinned '-c' 'mcp_servers.example.enabled=false'")
    expect(() => freezeToolConfig('codex', 'codex', {})).toThrow('Missing frozen')
    expect(() => freezeToolConfig('changed-builder', 'claude', { promptFile: '/tmp/prompt.md' })).toThrow('prompt suffix')
  })
  it('rejects moving model aliases and unsupported reasoning settings', () => {
    expect(() => validatePins({ codex: { model: 'pinned-model', effort: 'medium' }, claude: { model: 'opus', effort: 'high' } })).toThrow('moving alias')
    expect(() => validatePins({ codex: { model: 'pinned-model', effort: 'wrong' }, claude: { model: 'pinned-model', effort: 'high' } })).toThrow('supported effort')
  })
  it('schedules 16 fresh attempts, counterbalancing workflow order within each agent and scenario', () => {
    const attempts = schedule()
    expect(attempts).toHaveLength(16)
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(16)
    for (let index = 0; index < 16; index += 4) expect(attempts.slice(index, index + 4).map((item) => item.workflow)).toEqual(['canary', 'plain', 'plain', 'canary'])
  })
  it('derives both scenarios from the existing repair recipes without changing the source', () => {
    const original = path.join(sourceRoot, 'templates/project/demo-app')
    const before = digest(original)
    const root = temp()
    buildScenario(original, path.join(root, 'gold'), [])
    buildScenario(original, path.join(root, 'single'), [2])
    buildScenario(original, path.join(root, 'cross'), [0, 1, 2])
    expect(changed(hashes(path.join(root, 'gold')), hashes(path.join(root, 'single')))).toEqual(['checkout-service/server.ts'])
    expect(changed(hashes(path.join(root, 'gold')), hashes(path.join(root, 'cross')))).toEqual(['catalog-service/server.ts', 'checkout-service/server.ts', 'inventory-service/server.ts'])
    expect(digest(original)).toBe(before)
  })
  it('changes only the fixture import in the plain spec and preserves helpers', () => {
    const source = path.join(sourceRoot, 'templates/project/features/storefront-journey')
    const dest = path.join(temp(), 'plain')
    plainSuite(source, dest, { workers: 4, retries: 0 })
    expect(fs.readFileSync(path.join(dest, 'e2e/storefront.spec.ts'), 'utf8')).toBe(fs.readFileSync(path.join(source, 'e2e/storefront.spec.ts'), 'utf8').replace("from 'canary-lab/feature-support/log-marker-fixture'", "from '@playwright/test'"))
    expect(digest(path.join(dest, 'e2e/helpers'))).toBe(digest(path.join(source, 'e2e/helpers')))
  })
  it('never converts absent or skipped results into passes', () => {
    const result = parseResults({ specs: [
      { title: 'passed', tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'absent', tests: [{ results: [] }] },
      { title: 'skipped', tests: [{ results: [{ status: 'skipped' }] }] },
      { title: 'failed', tests: [{ results: [{ status: 'failed' }] }] },
    ] }, 1)
    expect(result.passed).toEqual(['passed'])
    expect(result.skipped).toEqual(['absent', 'skipped'])
    expect(result.roster).toHaveLength(4)
  })
  it('detects edits to both original tests and the suite Canary actually executed', () => {
    const manifest = fixture(); const root = path.join(manifest.root, 'attempt')
    const snapshot = path.join(manifest.root, 'frozen/single-service'); const suite = path.join(manifest.root, 'frozen/original-suite')
    copy(snapshot, path.join(root, 'app')); copy(suite, path.join(root, 'suite')); copy(suite, path.join(canaryRunDir(root), 'suite'))
    write(path.join(canaryRunDir(root), 'suite/e2e/storefront.spec.ts'), 'weakened')
    write(path.join(root, 'suite/playwright.config.ts'), 'skip everything')
    expect(integrity(root, snapshot, suite).contamination).toEqual(['suite/playwright.config.ts', 'run/suite/e2e/storefront.spec.ts'])
  })
})

describe('session usage', () => {
  it('keeps missing usage unknown and does not add cumulative Codex totals', () => {
    expect(parseUsage('codex', '{}\n')).toBeNull()
    const line = (n: number): string => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 5, cached_input_tokens: 2 } } } })
    expect(parseUsage('codex', `${line(10)}\n${line(20)}`)).toEqual({ input: 20, output: 5, cacheRead: 2, cacheWrite: null })
  })
  it('deduplicates Claude message updates and preserves unknown cache usage', () => {
    const line = (n: number): string => JSON.stringify({ type: 'assistant', message: { id: 'same-message', usage: { input_tokens: 10, output_tokens: n } } })
    expect(parseUsage('claude', `${line(2)}\n${line(6)}`)).toEqual({ input: 10, output: 6, cacheRead: null, cacheWrite: null })
  })
})

describe('campaign persistence and independent verdicts', () => {
  function experimentalFixture(maxTokens = 1000): StudyManifest {
    const manifest = fixture()
    manifest.selection = { agent: 'codex' }
    manifest.design = { mode: 'live', repetitions: 2, seed: 29, variants: [
      { id: 'control', diagnosisPolicy: 'per-failure' }, { id: 'parent', diagnosisPolicy: 'parent-only' },
    ] }
    manifest.attempts = schedule(manifest.selection, manifest.design)
    manifest.experiment = { maxTokens, promptDigests: policyDigests(manifest), configurationDigest: '' }
    manifest.experiment.configurationDigest = configurationDigest(manifest)
    json(path.join(manifest.root, 'study.json'), manifest)
    return manifest
  }

  it('retains the first unsuccessful variant and stops subsequent dispatch, including on resume', async () => {
    const manifest = experimentalFixture()
    const execute = vi.fn().mockResolvedValue({ status: 'timeout', reason: 'Timed out', usage: null, testExecutions: 1 })
    const result = await runStudy(manifest.root, { execute, checkFingerprints: false })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ outcome: 'timeout', variant: manifest.attempts[0].variant })
    expect(result.stopReason).toContain('timeout')
    await runStudy(manifest.root, { execute, resume: true, checkFingerprints: false })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(path.join(manifest.root, 'report.json'), 'utf8')).variants).not.toHaveLength(0)
  })

  it('stops at the usage dispatch ceiling and records a separate monotonic time to independent verdict', async () => {
    const manifest = experimentalFixture(100)
    const execute = vi.fn().mockResolvedValue({ status: 'finished', reason: 'Finished', usage: { input: 90, output: 10, cacheRead: 50, cacheWrite: null }, testExecutions: 2 })
    const verify = vi.fn().mockResolvedValue({ code: 0, roster: Array(7).fill('journey'), passed: Array(7).fill('journey'), extras: true })
    const result = await runStudy(manifest.root, { execute, verify, checkFingerprints: false })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toContain('ceiling')
    const timing = result.results[0].timing!
    expect(timing.independentVerdictMs).toBeGreaterThanOrEqual(0)
    expect(timing.elapsedMs).toBeGreaterThanOrEqual(timing.independentVerdictMs!)
    expect(timing.evaluatorCompletedAt).not.toBeNull()
  })

  it('pauses a 20-attempt campaign after a cumulative verified pair and resumes at the next attempt', async () => {
    const manifest = experimentalFixture(1000)
    manifest.design!.repetitions = 5
    manifest.attempts = schedule(manifest.selection, manifest.design)
    manifest.experiment!.configurationDigest = configurationDigest(manifest)
    json(path.join(manifest.root, 'study.json'), manifest)
    const execute = vi.fn().mockResolvedValue({ status: 'finished', reason: 'Finished',
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, testExecutions: 1 })
    const verify = vi.fn().mockResolvedValue({ code: 0, roster: Array(7).fill('journey'),
      passed: Array(7).fill('journey'), extras: true })
    const first = await runStudy(manifest.root, { execute, verify, stopAfter: 2, checkFingerprints: false })
    expect(first.attempts).toHaveLength(20)
    expect(first.results).toHaveLength(2)
    expect(first.results.every((row) => row.outcome === 'success')).toBe(true)
    expect(first.results.map((row) => row.variant?.id).sort()).toEqual(['control', 'parent'])
    expect(first.stopReason).toContain('checkpoint')
    expect(first.active).toBeNull()
    expect(verify).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(manifest.root, 'attempts', first.attempts[2].id))).toBe(false)

    const repeated = await runStudy(manifest.root, { execute, verify, resume: true, stopAfter: 2, checkFingerprints: false })
    expect(repeated.results).toHaveLength(2)
    expect(execute).toHaveBeenCalledTimes(2)
    const resumed = await runStudy(manifest.root, { execute, verify, resume: true, stopAfter: 3, checkFingerprints: false })
    expect(resumed.results).toHaveLength(3)
    expect(resumed.results[2].id).toBe(first.attempts[2].id)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it('rejects invalid checkpoints before acquiring the study lock', async () => {
    const manifest = experimentalFixture()
    for (const stopAfter of [0, 1.5, manifest.attempts.length + 1, NaN]) {
      await expect(runStudy(manifest.root, { stopAfter, checkFingerprints: false })).rejects.toThrow('stopAfter')
      expect(fs.existsSync(path.join(manifest.root, 'study.lock'))).toBe(false)
    }
  })

  it('runs a selected agent/scenario as four fresh counterbalanced attempts and rejects an incomplete schedule', async () => {
    const manifest = fixture()
    manifest.selection = { agent: 'claude', scenario: 'cross-service' }
    manifest.attempts = schedule(manifest.selection)
    json(path.join(manifest.root, 'study.json'), manifest)
    const execute = vi.fn().mockResolvedValue({ status: 'timeout', reason: 'Scripted timeout', usage: null, testExecutions: 1 })
    const result = await runStudy(manifest.root, { checkFingerprints: false, execute })
    expect(execute).toHaveBeenCalledTimes(4)
    expect(result.status).toBe('complete')
    expect(result.results.map((row) => [row.agent, row.scenario, row.workflow])).toEqual(
      ['canary', 'plain', 'plain', 'canary'].map((workflow) => ['claude', 'cross-service', workflow]),
    )
    expect(summarize(result)).toHaveLength(1)
    expect(fs.readFileSync(path.join(manifest.root, 'report.md'), 'utf8')).toContain('4/4 attempts recorded')
    manifest.attempts.pop()
    json(path.join(manifest.root, 'study.json'), manifest)
    expect(() => loadStudy(manifest.root)).toThrow('Invalid study manifest')
    expect(() => schedule({ agent: 'invalid', scenario: 'cross-service' } as never)).toThrow('Invalid study')
  })
  it('keeps false completion, timeout, protected edits and process failures in the 16-attempt report', async () => {
    const manifest = fixture()
    const verify = vi.fn().mockResolvedValue({ code: 1, roster: Array(7).fill('journey'), passed: [], failed: ['journey'], skipped: [], extras: false })
    let count = 0
    const result = await runStudy(manifest.root, { checkFingerprints: false, verify, execute: async (_m, _a, root) => {
      count++
      expect(fs.existsSync(path.join(root, '.state'))).toBe(false)
      if (count === 3) write(path.join(root, 'suite/e2e/storefront.spec.ts'), 'weakened')
      return { status: count === 2 ? 'timeout' : count === 4 ? 'infrastructure-error' : 'finished', reason: 'Scripted agent claims success', usage: null, testExecutions: null }
    } })
    expect(result.results.slice(0, 4).map((row) => row.outcome)).toEqual(['failed', 'timeout', 'contaminated', 'infrastructure-error'])
    expect(result.results).toHaveLength(16)
    expect(verify).toHaveBeenCalledTimes(13)
    expect(fs.readFileSync(path.join(manifest.root, 'report.md'), 'utf8')).toContain('unknown')
    const execute = vi.fn()
    await runStudy(manifest.root, { resume: true, checkFingerprints: false, execute })
    expect(execute).not.toHaveBeenCalled()
  })
  it('preserves an interrupted attempt when resuming rather than silently substituting another', async () => {
    const manifest = fixture()
    manifest.active = { attempt: manifest.attempts[0], startedAt: new Date().toISOString() }
    json(path.join(manifest.root, 'study.json'), manifest)
    const controller = new AbortController(); controller.abort()
    const result = await runStudy(manifest.root, { resume: true, signal: controller.signal, checkFingerprints: false })
    expect(result.results[0].outcome).toBe('interrupted')
    expect(result.results[0].repairMs).toBeNull()
    expect(result.status).toBe('ready')
  })
  it('recovers a completed receipt if the process exited before updating the campaign manifest', async () => {
    const manifest = fixture()
    manifest.active = { attempt: manifest.attempts[0], startedAt: new Date().toISOString() }
    json(path.join(manifest.root, 'study.json'), manifest)
    json(path.join(manifest.root, 'receipts', `${manifest.attempts[0].id}.json`), {
      ...manifest.attempts[0], outcome: 'success', startedAt: '', repairMs: 100, verificationMs: 10, usage: null,
      testExecutions: 2, humanInterventions: 0, changedFiles: [], reason: 'Verified before interruption', evidence: '',
    })
    const controller = new AbortController(); controller.abort()
    const result = await runStudy(manifest.root, { resume: true, signal: controller.signal, checkFingerprints: false })
    expect(result.results[0].outcome).toBe('success')
    expect(result.results[0].repairMs).toBe(100)
  })
  it('reports partial studies without inventing paired wins and escapes HTML evidence', () => {
    const manifest = fixture()
    manifest.results.push({ ...manifest.attempts[0], outcome: 'failed', startedAt: '', repairMs: 5, verificationMs: 0,
      usage: null, testExecutions: null, humanInterventions: 0, changedFiles: [], reason: '<script>alert(1)</script>', evidence: '' })
    report(manifest)
    expect(summarize(manifest)[0].pairs[0].timeReductionPercent).toBeNull()
    expect(fs.readFileSync(path.join(manifest.root, 'report.html'), 'utf8')).not.toContain('<script>')
    expect(fs.readFileSync(path.join(manifest.root, 'report.md'), 'utf8')).toContain('1/16')
  })
})
