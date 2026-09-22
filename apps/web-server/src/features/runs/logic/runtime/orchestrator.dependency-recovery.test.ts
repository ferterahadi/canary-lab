import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunOrchestrator } from './orchestrator'
import { addWorktree } from './repo-worktree'
import { readManifest } from './manifest'
import { writeHealSignal } from '../heal/external-heal-surface'
import type { PtyHandle } from './pty-spawner'
import type { DependencyPreparation, FeatureConfig } from '../../../../../../../shared/launcher/types'

let root: string
let source: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: source, stdio: 'ignore' })
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dependency-recovery-')))
  source = path.join(root, 'source')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{"version":1}')
  fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n')
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function fakePty(playwright = false): PtyHandle {
  return {
    pid: 0,
    onData: () => ({ dispose() {} }),
    onExit: (callback) => {
      if (playwright) queueMicrotask(() => callback({ exitCode: 0 }))
      return { dispose() {} }
    },
    write() {}, resize() {}, kill() {},
  }
}

async function setup(dependencyPreparation: DependencyPreparation = {
  mode: 'isolated', prepareCommand: 'mkdir -p node_modules', validateCommand: 'test -f dependencies-ready',
}) {
  const runId = 'run-1'
  const logsDir = path.join(root, 'logs')
  const runDir = path.join(logsDir, 'runs', runId)
  const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(runDir, 'worktrees') })
  const featureDir = path.join(root, 'features', 'demo')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'e2e', 'demo.spec.ts'), "import { test } from '@playwright/test'; test('case', async () => {});")
  const feature: FeatureConfig = {
    name: 'demo', description: 'demo', envs: ['local'], featureDir,
    repos: [{
      name: 'app', localPath: source,
      dependencyPreparation,
      startCommands: [{ name: 'api', command: 'service-api' }, { name: 'worker', command: 'service-worker' }],
    }],
  }
  const configPath = path.join(featureDir, 'feature.config.cjs')
  const writeConfig = (config: FeatureConfig) => fs.writeFileSync(configPath, `module.exports.config = ${JSON.stringify(config)}`)
  writeConfig(feature)
  const observed: Array<{ command: string; manifest: ReturnType<typeof readManifest> }> = []
  const orch = new RunOrchestrator({
    runId, runDir, worktrees: [handle], externalHeal: true,
    feature,
    healthPollIntervalMs: 5, healSignalPollMs: 5, healAgentTimeoutMs: 5000,
    playwrightSpawner: () => ({ command: 'playwright', cwd: featureDir }),
    ptyFactory: ({ command }) => {
      observed.push({ command, manifest: readManifest(orch.paths.manifestPath) })
      if (command === 'playwright') {
        fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ complete: true, total: 1, passed: 1, passedNames: ['case'], knownTests: [{ name: 'case', title: 'case' }], failed: [], skipped: 0 }))
      }
      return fakePty(command === 'playwright')
    },
  })
  return { orch, handle, observed, logsDir, feature, configPath, writeConfig }
}

async function waiting(orch: RunOrchestrator, minCycle: number) {
  await vi.waitFor(() => {
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.lifecycle?.phase).toBe('waiting-for-signal')
    expect(manifest.healCycles).toBeGreaterThanOrEqual(minCycle)
    expect(orch.isWaitingForHealSignal()).toBe(true)
  }, { timeout: 5000, interval: 10 })
}

describe('dependency recovery before runner verification', () => {
  it('links shared dependencies during the real boot preflight before service spawn', async () => {
    fs.mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(source, 'node_modules', '.bin', 'concurrently'), '#!/bin/sh\n')
    const { orch, handle, observed } = await setup({ mode: 'shared', validateCommand: 'test -f node_modules/.bin/concurrently' })
    try {
      await orch.start()
      const linkedDeps = path.join(handle.worktreeRoot, 'node_modules')
      expect(fs.lstatSync(linkedDeps).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(linkedDeps)).toBe(fs.realpathSync(path.join(source, 'node_modules')))
      expect(fs.existsSync(path.join(linkedDeps, '.bin', 'concurrently'))).toBe(true)
      expect(observed).toHaveLength(2)
      // A shared tree remains mutable: passing validation allows boot but
      // does not promote it to durable compatible evidence.
      for (const { manifest } of observed) {
        expect(manifest?.dependencyProvenance?.[0]).toMatchObject({ verdict: 'unknown', validation: { exitCode: 0 } })
      }
    } finally {
      await orch.stop('aborted')
    }
  })

  it.each(['restart', 'rerun'] as const)('%s persists a fresh rejection, then fresh repaired evidence before any process starts', async (kind) => {
    const { orch, handle, observed, logsDir } = await setup()
    const cycle = orch.runFullCycle()
    try {
      await waiting(orch, 1)
      const first = readManifest(orch.paths.manifestPath)!.dependencyProvenance![0]
      expect(first).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'validation-failed', checkedAt: expect.any(String) })
      expect(readManifest(orch.paths.manifestPath)!.services.map((service) => service.status)).toEqual(['timeout', 'timeout'])
      writeHealSignal({ logsDir, runId: orch.runId, kind, body: { hypothesis: 'unchanged dependencies', fixDescription: 'request verification' } })
      await waiting(orch, 2)
      const rejected = readManifest(orch.paths.manifestPath)!.dependencyProvenance!
      expect(rejected).toHaveLength(1)
      expect(rejected[0].verdict).toBe('incompatible')
      expect(rejected[0].validation!.logPath).not.toBe(first.validation!.logPath)
      expect(fs.existsSync(first.validation!.logPath)).toBe(true)
      expect(observed).toEqual([])

      fs.writeFileSync(path.join(handle.worktreeRoot, 'dependencies-ready'), 'repaired')
      writeHealSignal({ logsDir, runId: orch.runId, kind, body: { hypothesis: 'validator input was missing', fixDescription: 'repair validator input' } })
      await vi.waitFor(() => {
        const manifest = readManifest(orch.paths.manifestPath)
        expect(manifest?.status).toBe('passed')
      }, { timeout: 5000, interval: 10 })
      await expect(cycle).resolves.toBe('passed')
      expect(observed.map(({ command }) => command)).toEqual([expect.stringContaining('service-api'), expect.stringContaining('service-worker'), 'playwright'])
      for (const { manifest } of observed) {
        expect(manifest!.dependencyProvenance).toHaveLength(1)
        expect(manifest!.dependencyProvenance![0]).toMatchObject({ verdict: 'compatible', checkedAt: expect.any(String) })
        expect(manifest!.bootFailure).toBeUndefined()
      }
    } finally {
      await orch.stop('aborted')
      await cycle
    }
  }, 15000)

  it('restart cannot reuse a compatible verdict after dependencies change', async () => {
    const { orch, handle, observed } = await setup()
    fs.writeFileSync(path.join(handle.worktreeRoot, 'dependencies-ready'), 'ready')
    try {
      await orch.start()
      expect(observed).toHaveLength(2)
      fs.unlinkSync(path.join(handle.worktreeRoot, 'dependencies-ready'))
      const restarted = await orch.restart()
      expect(observed).toHaveLength(2)
      expect(restarted.restarted).toEqual([])
      expect(restarted.startedBecauseMissing).toEqual([])
      expect(readManifest(orch.paths.manifestPath)!.dependencyProvenance![0]).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'validation-failed' })
      expect(readManifest(orch.paths.manifestPath)!.bootFailure?.reason).toBe('dependency-incompatible')
    } finally {
      await orch.stop('aborted')
    }
  })

  it('reloads repaired dependency preparation without adopting changed service commands', async () => {
    const { orch, observed, feature, writeConfig } = await setup()
    try {
      await orch.start()
      expect(observed).toEqual([])
      writeConfig({ ...feature, repos: [{ ...feature.repos![0],
        dependencyPreparation: { mode: 'isolated', prepareCommand: 'mkdir -p node_modules && touch dependencies-ready', validateCommand: 'test -f dependencies-ready' },
        startCommands: [{ name: 'changed-service', command: 'must-not-run' }],
      }] })
      await orch.restart()
      expect(observed.map(({ command }) => command)).toEqual([expect.stringContaining('service-api'), expect.stringContaining('service-worker')])
      expect(readManifest(orch.paths.manifestPath)!.dependencyProvenance![0].verdict).toBe('compatible')
    } finally {
      await orch.stop('aborted')
    }
  })

  it.each(['missing', 'malformed'] as const)('keeps %s preparation config as an actionable block before restart spawn', async (problem) => {
    const { orch, observed, handle, configPath } = await setup()
    fs.writeFileSync(path.join(handle.worktreeRoot, 'dependencies-ready'), 'ready')
    try {
      await orch.start()
      if (problem === 'missing') fs.unlinkSync(configPath)
      else fs.writeFileSync(configPath, 'module.exports.config = { invalid syntax')
      await orch.restart()
      expect(observed).toHaveLength(2)
      expect(readManifest(orch.paths.manifestPath)!.dependencyProvenance![0]).toMatchObject({
        verdict: 'incompatible', incompatibilityCause: 'configuration-invalid', remediation: expect.stringContaining(configPath),
      })
      expect(readManifest(orch.paths.manifestPath)!.bootFailure?.reason).toBe('dependency-incompatible')
    } finally {
      await orch.stop('aborted')
    }
  })

  it.each(['all preparation', 'validator', 'all inputs', 'one input', 'isolation'] as const)('blocks removal of %s proof requirements during active recovery', async (removed) => {
    const required: DependencyPreparation = {
      mode: 'isolated', prepareCommand: 'mkdir -p node_modules', validateCommand: 'test -f dependencies-ready',
      generatorInputs: ['schema.txt', 'secondary.schema'],
    }
    const { orch, handle, observed, feature, writeConfig } = await setup(required)
    try {
      await orch.start()
      expect(readManifest(orch.paths.manifestPath)!.dependencyProvenance![0].incompatibilityCause).toBe('validation-failed')
      fs.writeFileSync(path.join(handle.worktreeRoot, 'dependencies-ready'), 'repaired')
      const repairs: Record<typeof removed, DependencyPreparation | undefined> = {
        'all preparation': undefined,
        validator: { ...required, validateCommand: undefined },
        'all inputs': { ...required, generatorInputs: undefined },
        'one input': { ...required, generatorInputs: ['schema.txt'] },
        isolation: { ...required, mode: 'shared' },
      }
      writeConfig({ ...feature, repos: [{ ...feature.repos![0], dependencyPreparation: repairs[removed] }] })
      await orch.restart()
      expect(observed).toEqual([])
      expect(readManifest(orch.paths.manifestPath)!.dependencyProvenance![0]).toMatchObject({
        verdict: 'incompatible', incompatibilityCause: 'configuration-invalid', remediation: expect.stringContaining('Restore dependencyPreparation.'),
      })
    } finally {
      await orch.stop('aborted')
    }
  })
})
