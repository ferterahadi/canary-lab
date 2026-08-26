import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HEAL_AGENT_ISOLATION_SETTINGS, writeHealAgentIsolationSettings } from './heal-agent-isolation'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-isolation-')))
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('writeHealAgentIsolationSettings', () => {
  it('allows the run worktree while denying the source checkout and authored suite', () => {
    const runDir = path.join(root, 'run')
    const sourceRoot = path.join(root, 'source')
    const worktreeRoot = path.join(root, 'worktree')
    const sourceApp = path.join(sourceRoot, 'apps', 'api')
    const worktreeApp = path.join(worktreeRoot, 'apps', 'api')
    const featureDir = path.join(root, 'features', 'checkout')

    const settingsPath = writeHealAgentIsolationSettings({
      runDir,
      writableDirs: [worktreeApp, worktreeApp],
      featureDir,
      featureDirReadOnly: true,
      worktrees: [{ repoName: 'api', sourceRoot, worktreeRoot, localPath: worktreeApp }],
    })
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

    expect(settingsPath).toBe(path.join(runDir, HEAL_AGENT_ISOLATION_SETTINGS))
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [worktreeApp],
        denyWrite: [featureDir, sourceApp],
      },
    })
    expect(settings.permissions.deny).toEqual([
      `Edit(/${featureDir}/**)`,
      `Edit(/${sourceApp}/**)`,
    ])
  })

  it('fails closed when a protected source path contains the requested worktree path', () => {
    const sourceRoot = path.join(root, 'source')
    const worktreeRoot = path.join(sourceRoot, 'logs', 'worktree')
    expect(() => writeHealAgentIsolationSettings({
      runDir: path.join(root, 'run'),
      writableDirs: [worktreeRoot],
      featureDir: path.join(root, 'features', 'checkout'),
      featureDirReadOnly: true,
      worktrees: [{ repoName: 'app', sourceRoot, worktreeRoot, localPath: worktreeRoot }],
    })).toThrow(/cannot isolate heal agent/)
  })

  it('keeps the suite writable when a feature has no service repo to repair', () => {
    const featureDir = path.join(root, 'features', 'api-contract')
    const settingsPath = writeHealAgentIsolationSettings({
      runDir: path.join(root, 'run'),
      writableDirs: [featureDir],
      featureDir,
      featureDirReadOnly: false,
      worktrees: [],
    })
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

    expect(settings.permissions.deny).toEqual([])
    expect(settings.sandbox.filesystem.allowWrite).toEqual([featureDir])
    expect(settings.sandbox.filesystem.denyWrite).toEqual([])
  })
})
