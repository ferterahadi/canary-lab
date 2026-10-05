import fs from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { createRestartedOrchestrator } from './restart-orchestrator'
import { RunnerLog } from './runtime/runner-log'
import type { OrchestratorOptions } from './runtime/run-orchestrator-types'

const construction = vi.hoisted(() => ({ error: null as Error | null }))

// The real constructor prepares a runtime with native PTYs. Keep its option
// contract while controlling the constructor failure at that boundary.
vi.mock('./runtime/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime/orchestrator')>()),
  RunOrchestrator: class {
    constructor(readonly options: OrchestratorOptions) {
      if (construction.error) throw construction.error
    }
  },
}))

const tempDir = trackTempDirs('restart-orchestrator-')
beforeEach(() => { construction.error = null })

function fixture(applied: boolean) {
  const dir = tempDir()
  const target = path.join(dir, '.env')
  const backup = `${target}.bak`
  fs.writeFileSync(target, applied ? 'APPLIED=1\n' : 'ORIGINAL=1\n')
  if (applied) fs.writeFileSync(backup, 'ORIGINAL=1\n')
  const options: Parameters<typeof createRestartedOrchestrator>[0] = {
    feature: { name: 'checkout', description: 'Checkout', featureDir: dir, envs: ['local'] },
    env: 'local', runId: 'run-1', runDir: dir, initialHealCycles: 2,
    resources: { ok: true, portMap: new Map([['api', 12345]]),
      backups: applied ? [{ originalPath: target, backupPath: backup }] : null,
      repoBranchSnapshots: [] },
    ptyFactory: vi.fn(() => { throw new Error('unexpected PTY launch') }),
    runnerLog: new RunnerLog(path.join(dir, 'runner.log')),
    runStateSink: undefined, dirtySpecHooks: undefined,
    attachRunStreams: vi.fn(),
    modeOptions: { manualHeal: true, projectRoot: dir },
    failureLogPrefix: 'Run restart failed',
  }
  return { options, target, backup, dir }
}

describe('createRestartedOrchestrator', () => {
  it('attaches the constructed runtime while leaving restoration to run completion', () => {
    const { options, target, backup } = fixture(true)
    const result = createRestartedOrchestrator(options)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('restart failed')
    expect(result.orch).toMatchObject({ options: {
      feature: options.feature, env: 'local', runId: 'run-1', runDir: options.runDir,
      initialHealCycles: 2, portMap: options.resources.portMap,
      repoBranchSnapshots: options.resources.repoBranchSnapshots,
      ptyFactory: options.ptyFactory, runnerLog: options.runnerLog,
      runStateSink: undefined, dirtySpecHooks: undefined,
      manualHeal: true, projectRoot: options.modeOptions.projectRoot,
    } })
    expect(options.attachRunStreams).toHaveBeenCalledExactlyOnceWith(result.orch, options.runnerLog, 'checkout', options.resources.backups)
    expect(fs.readFileSync(target, 'utf8')).toBe('APPLIED=1\n')
    expect(fs.existsSync(backup)).toBe(true)
  })

  it.each([false, true])('reports constructor failure and restores applied inputs (%s)', (applied) => {
    const { options, target, backup, dir } = fixture(applied)
    construction.error = new Error('native binding unavailable')
    expect(createRestartedOrchestrator(options)).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(options.attachRunStreams).not.toHaveBeenCalled()
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL=1\n')
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'runner.log'), 'utf8')).toContain('Run restart failed: native binding unavailable')
  })

  it('propagates attachment failure without applying constructor rollback', () => {
    const { options, target, backup, dir } = fixture(true)
    const error = new Error('stream unavailable')
    options.attachRunStreams = () => { throw error }
    expect(() => createRestartedOrchestrator(options)).toThrow(error)
    expect(fs.readFileSync(target, 'utf8')).toBe('APPLIED=1\n')
    expect(fs.existsSync(backup)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'runner.log'), 'utf8')).not.toContain('restart failed')
  })
})
