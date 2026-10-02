import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { initGitRepo, git } from '../../../../../../tools/test-helpers/git-repo'
import { prepareRestartResources } from './restart-preparation'
import { RunnerLog } from './runtime/runner-log'
import { restore } from './runtime/env-switcher/switch'
import * as portAllocator from './runtime/port-allocator'

const tempDir = trackTempDirs('restart-preparation-')
afterEach(() => vi.restoreAllMocks())

function fixture(env: string | undefined = 'local') {
  const featureDir = tempDir()
  const repo = initGitRepo(path.join(featureDir, 'app'), { branch: 'main', commit: 'empty' })
  const feature: FeatureConfig = {
    name: 'checkout', description: 'Restart preparation', featureDir, envs: ['local'],
    repos: [{ name: 'app', localPath: repo, branch: 'main' }],
  }
  const runnerLog = new RunnerLog(path.join(featureDir, 'runner.log'))
  const options = { feature, env, runnerLog, envsetAppliedMessage: 'Applied restart environment' }
  const target = path.join(repo, '.env')
  const setDir = path.join(featureDir, 'envsets', 'local')
  function addEnvset() {
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(target, 'ORIGINAL=1\n')
    fs.writeFileSync(path.join(setDir, 'app-env'), 'APPLIED=1\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), JSON.stringify({
      appRoots: {}, slots: { 'app-env': { description: 'app environment', target } },
      feature: { slots: ['app-env'], testCommand: 'true', testCwd: repo },
    }))
  }
  return { featureDir, repo, feature, options, target, setDir, addEnvset }
}

describe('prepareRestartResources', () => {
  it.each([undefined, 'local'])('captures branch evidence without an applied envset (%s)', async (env) => {
    const f = fixture()
    const result = await prepareRestartResources({ ...f.options, env })
    expect(result).toEqual({
      ok: true, portMap: undefined, backups: null,
      repoBranchSnapshots: [{ name: 'app', path: f.repo, branch: 'main', expectedBranch: 'main', detached: false, dirty: false, sha: git(f.repo, 'rev-parse', 'HEAD') }],
    })
    expect(fs.readFileSync(path.join(f.featureDir, 'runner.log'), 'utf8')).toBe('')
  })

  it.each([true, false])('hands off restoration ownership after preparation (existing target: %s)', async (existing) => {
    const f = fixture()
    f.addEnvset()
    if (!existing) fs.unlinkSync(f.target)
    const result = await prepareRestartResources(f.options)
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(fs.readFileSync(f.target, 'utf8')).toBe('APPLIED=1\n')
    expect(result.backups).toHaveLength(1)
    expect(result.repoBranchSnapshots[0]).toMatchObject({ branch: 'main', dirty: true })
    expect(fs.readFileSync(path.join(f.featureDir, 'runner.log'), 'utf8')).toContain(f.options.envsetAppliedMessage)
    restore(result.backups!)
    if (existing) expect(fs.readFileSync(f.target, 'utf8')).toBe('ORIGINAL=1\n')
    else expect(fs.existsSync(f.target)).toBe(false)
  })

  it.each([true, false])('rejects a branch mismatch and restores any environment (applied: %s)', async (applied) => {
    const f = fixture()
    if (applied) f.addEnvset()
    f.feature.repos![0].branch = 'other'
    const result = await prepareRestartResources(f.options)
    expect(result).toMatchObject({ ok: false, stage: 'branches', error: expect.any(Error) })
    if (applied) expect(fs.readFileSync(f.target, 'utf8')).toBe('ORIGINAL=1\n')
    else expect(fs.existsSync(f.target)).toBe(false)
    expect(fs.readdirSync(f.repo).some((name) => name.includes('.bak.'))).toBe(false)
  })

  it('restores the environment when snapshot collection fails after branch validation', async () => {
    const f = fixture()
    f.addEnvset()
    // No pinned branch means validation skips this repo; the real corrupt Git
    // index fails the subsequent status read while collecting its snapshot.
    delete f.feature.repos![0].branch
    fs.writeFileSync(path.join(f.repo, '.git', 'index'), 'broken index')
    const result = await prepareRestartResources(f.options)
    expect(result).toMatchObject({ ok: false, stage: 'branches', error: expect.any(Error) })
    expect(fs.readFileSync(f.target, 'utf8')).toBe('ORIGINAL=1\n')
  })

  it('forwards allocated ports into the environment and the returned resources', async () => {
    const f = fixture()
    f.addEnvset()
    f.feature.repos![0].startCommands = [{ name: 'app', command: 'serve', ports: [{ name: 'api', env: 'PORT' }] }]
    const ports = new Map([['api', 43210]])
    vi.spyOn(portAllocator, 'allocatePorts').mockResolvedValue(ports)
    fs.writeFileSync(path.join(f.setDir, 'app-env'), 'PORT=${port.api}\n')
    const result = await prepareRestartResources(f.options)
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.portMap).toBe(ports)
    expect(fs.readFileSync(f.target, 'utf8')).toBe('PORT=43210\n')
    restore(result.backups!)
  })

  it('leaves partial-application rollback with the envset primitive', async () => {
    const f = fixture()
    f.addEnvset()
    // The second source is a directory: backup succeeds for both targets, then
    // copying it fails after the first slot has already changed the real file.
    fs.mkdirSync(path.join(f.setDir, 'broken-env'))
    const missingTarget = path.join(f.repo, '.env.second')
    fs.writeFileSync(path.join(f.featureDir, 'envsets', 'envsets.config.json'), JSON.stringify({
      appRoots: {}, slots: {
        'app-env': { description: 'app environment', target: f.target },
        'broken-env': { description: 'broken source', target: missingTarget },
      },
      feature: { slots: ['app-env', 'broken-env'], testCommand: 'true', testCwd: f.repo },
    }))
    const result = await prepareRestartResources(f.options)
    expect(result).toMatchObject({ ok: false, stage: 'envset', error: expect.any(Error) })
    expect(fs.readFileSync(f.target, 'utf8')).toBe('ORIGINAL=1\n')
    expect(fs.existsSync(missingTarget)).toBe(false)
    expect(fs.readdirSync(f.repo).some((name) => name.includes('.bak.'))).toBe(false)
  })

  it('propagates port allocation failure before changing environment files', async () => {
    const f = fixture()
    f.addEnvset()
    f.feature.repos![0].startCommands = [{ name: 'app', command: 'serve', ports: [{ name: 'api', env: 'PORT' }] }]
    const error = new Error('No free ports')
    vi.spyOn(portAllocator, 'allocatePorts').mockRejectedValue(error)
    await expect(prepareRestartResources(f.options)).rejects.toBe(error)
    expect(fs.readFileSync(f.target, 'utf8')).toBe('ORIGINAL=1\n')
  })
})
