import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { baseConfig } from '../../shared/configs/playwright.base'
import { canaryRunDir, command, copy, json, quote, sourceRoot, write } from './files'
import { buildScenario, plainSuite, schedule } from './scenarios'
import { dependencies, evaluate } from './evaluator'
import { runCanary, runPlain } from './agents'
import { integrity } from './study'
import { prepareIsolation } from './isolation'
import type { StudyManifest } from './types'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-study-adapters-')))
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

it('runs real Canary and independent plain adapters with scripted repair processes, then checks their application changes', async () => {
  if (process.platform !== 'darwin') {
    await expect(prepareIsolation(root, root)).rejects.toThrow('requires macOS sandbox-exec')
    return
  }
  vi.stubEnv('CANARY_LAB_NO_WORKSPACE_TRUST', '1')
  const deps = path.join(root, 'runtime/node_modules')
  fs.mkdirSync(deps, { recursive: true })
  // Copy the small service toolchain: sandboxed agents cannot read the source
  // checkout even through dependency symlinks. No live workspace is consulted.
  for (const name of ['tsx', 'esbuild', '@esbuild', '@playwright', 'playwright', 'playwright-core']) {
    fs.cpSync(path.join(sourceRoot, 'node_modules', name), path.join(deps, name), { recursive: true, dereference: true })
  }
  fs.mkdirSync(path.join(deps, 'canary-lab'), { recursive: true })
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(deps, 'canary-lab/package.json'))
  fs.cpSync(path.join(sourceRoot, 'dist/shared'), path.join(deps, 'canary-lab/dist/shared'), { recursive: true })
  fs.mkdirSync(path.join(deps, '.bin'), { recursive: true })
  fs.symlinkSync('../tsx/dist/cli.mjs', path.join(deps, '.bin/tsx'))
  fs.symlinkSync('../@playwright/test/cli.js', path.join(deps, '.bin/playwright'))
  const sourceApp = path.join(sourceRoot, 'templates/project/demo-app')
  const sourceSuite = path.join(sourceRoot, 'templates/project/features/storefront-journey')
  buildScenario(sourceApp, path.join(root, 'frozen/single-service'), [2])
  copy(sourceSuite, path.join(root, 'frozen/original-suite'))
  plainSuite(sourceSuite, path.join(root, 'frozen/plain-suite'), { ...baseConfig, workers: 4, maxFailures: 4, use: { ...baseConfig.use, video: 'off' } })
  const manifest = { root, pins: { codex: { model: 'fixture', effort: 'medium' }, claude: { model: 'fixture', effort: 'high' } }, budgetMs: 60_000 } as StudyManifest
  json(path.join(root, 'study.json'), manifest)
  for (const scheduled of schedule().filter((item) => item.scenario === 'single-service' && item.repetition === 1)) {
    const policy = scheduled.agent === 'codex' ? 'parent-only' as const : 'adaptive' as const
    const attempt = { ...scheduled, ...(scheduled.workflow === 'canary' ? { variant: { id: policy, diagnosisPolicy: policy } } : {}) }
    const work = path.join(root, 'attempts', attempt.id)
    const suite = path.join(root, 'frozen', attempt.workflow === 'canary' ? 'original-suite' : 'plain-suite')
    copy(path.join(root, 'frozen/single-service'), path.join(work, 'app')); copy(suite, path.join(work, 'suite')); dependencies(work, root)
    const agentFile = path.join(work, 'scripted-agent.cjs')
    const patch = `const fs=require('fs');const p=${JSON.stringify(path.join(work, 'app/checkout-service/server.ts'))};fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('const total = (cart: Cart): number => subtotal(cart)','const total = (cart: Cart): number => Math.round(subtotal(cart) * (100 - cart.discountPercent) / 100)'));`
    write(agentFile, `process.stdout.write('scripted agent started\\n');` + patch + (attempt.workflow === 'canary' ? `fs.writeFileSync(${JSON.stringify(path.join(canaryRunDir(work), 'signals/.restart'))},'');` : ''))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)
    try {
      const result = attempt.workflow === 'canary'
        ? await runCanary(manifest, attempt, work, controller.signal, () => `${quote(process.execPath)} ${quote(agentFile)}`)
        : await runPlain(manifest, attempt, work, controller.signal, { command: process.execPath, args: [agentFile] })
      expect(result.status).toBe('finished')
      if (attempt.workflow === 'canary') {
        expect(fs.readFileSync(path.join(work, 'agent-terminal.log'), 'utf8')).toContain('scripted agent started')
        const run = JSON.parse(fs.readFileSync(path.join(canaryRunDir(work), 'manifest.json'), 'utf8'))
        expect(run.services).toHaveLength(3)
        expect(run.diagnosisPolicy).toBe(policy)
        expect(fs.readFileSync(path.join(work, 'prompts/cycle-1.md'), 'utf8')).toContain(`Diagnosis policy: ${policy}`)
        const promptReceipt = JSON.parse(fs.readFileSync(path.join(work, 'prompts/cycle-1.json'), 'utf8'))
        expect(promptReceipt.diagnosisPolicy).toBe(policy)
        expect(promptReceipt.digest).toMatch(/^[a-f0-9]{64}$/)
        expect(JSON.parse(fs.readFileSync(path.join(work, 'stage-intervals.json'), 'utf8')).length).toBeGreaterThan(0)
        const tail = path.join(canaryRunDir(work), 'heal-agent-tail.txt')
        const diagnostic = fs.readFileSync(path.join(canaryRunDir(work), 'runner.log'), 'utf8') + (fs.existsSync(tail) ? fs.readFileSync(tail, 'utf8') : '')
        expect(result.reason, diagnostic).toContain('passed')
        expect(result.testExecutions).toBeGreaterThanOrEqual(2)
      } else expect(fs.existsSync(path.join(canaryRunDir(work), 'manifest.json'))).toBe(false)
      expect(integrity(work, path.join(root, 'frozen/single-service'), suite).contamination).toEqual([])
      const evidence = await evaluate(root, path.join(work, 'app'), path.join(root, 'frozen/original-suite'), path.join(root, 'evaluation', attempt.id), true)
      expect(evidence.passed).toHaveLength(7)
      expect(evidence.extras).toBe(true)
    } finally { clearTimeout(timeout) }
  }
  const workspace = path.join(root, 'demo')
  copy(sourceApp, path.join(workspace, 'demo-app'))
  copy(sourceSuite, path.join(workspace, 'features/storefront-journey'))
  json(path.join(workspace, 'package.json'), { name: 'study-fixture', private: true })
  json(path.join(workspace, 'package-lock.json'), { name: 'study-fixture', lockfileVersion: 3 })
  fs.cpSync(deps, path.join(workspace, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  const bin = path.join(root, 'version-stubs')
  for (const agent of ['codex', 'claude']) {
    const executable = path.join(bin, agent)
    write(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "study-version-stub"; elif [ "$1" = "--disable" ]; then echo "[]"; else exit 99; fi\n')
    fs.chmodSync(executable, 0o755)
  }
  const preparedRoot = path.join(root, 'prepared')
  const prepared = await command(process.execPath, ['--import', 'tsx', path.join(sourceRoot, 'tools/benchmark-study/cli.ts'), 'prepare', '--repetitions', '2',
    '--workspace', workspace, '--out', preparedRoot, '--codex-model', 'study-fixture', '--codex-effort', 'medium', '--claude-model', 'study-fixture', '--claude-effort', 'high'],
    { cwd: sourceRoot, env: { PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 60_000 })
  expect(prepared.code, prepared.stderr + prepared.stdout).toBe(0)
  const preparedManifest = JSON.parse(fs.readFileSync(path.join(preparedRoot, 'study.json'), 'utf8'))
  expect(preparedManifest.status).toBe('ready')
  expect(preparedManifest.attempts).toHaveLength(16)
  expect(preparedManifest.results).toEqual([])
  expect(fs.existsSync(path.join(preparedRoot, 'report.html'))).toBe(true)
  // This exercises the public replay CLI and real worker/adapters. The version
  // stubs reject all paid-agent invocations, and replay also works without them.
  const replayRoot = path.join(root, 'replay')
  const replayPrepared = await command(process.execPath, ['--import', 'tsx', path.join(sourceRoot, 'tools/benchmark-study/cli.ts'), 'prepare',
    '--mode', 'replay', '--repetitions', '2', '--seed', '42', '--agent', 'codex', '--scenario', 'cross-service',
    '--workspace', workspace, '--out', replayRoot], { cwd: sourceRoot, timeoutMs: 60_000 })
  expect(replayPrepared.code, replayPrepared.stderr + replayPrepared.stdout).toBe(0)
  // Runtime replay must use frozen patches, not the mutable preparation reference.
  fs.writeFileSync(path.join(replayRoot, 'reference/checkout-service/server.ts'), 'throw new Error("reference changed")')
  const replayed = await command(process.execPath, ['--import', 'tsx', path.join(sourceRoot, 'tools/benchmark-study/cli.ts'), 'run', '--study', replayRoot],
    { cwd: sourceRoot, timeoutMs: 120_000 })
  expect(replayed.code, replayed.stderr + replayed.stdout).toBe(0)
  const replayManifest = JSON.parse(fs.readFileSync(path.join(replayRoot, 'study.json'), 'utf8'))
  expect(replayManifest.status).toBe('complete')
  expect(replayManifest.results).toHaveLength(4)
  for (const result of replayManifest.results) {
    expect(result.outcome, result.reason).toBe('success')
    expect(result.testExecutions).toBe(2)
    expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(result.telemetry.status).toBe('not-applicable')
    expect(result.changedFiles).toHaveLength(3)
  }
  expect(fs.readFileSync(path.join(replayRoot, 'report.md'), 'utf8')).toContain('Scripted local overhead replay')

}, 240_000)
