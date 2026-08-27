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

  it('excludes a nested service-repo subtree from feature-dir protection instead of failing closed', () => {
    // Unlike the worktree case above, a repo living inside (or as) the
    // feature dir has no worktree standing between the agent and the source —
    // there is no separate "pristine" copy to protect, so the overlap is a
    // supported layout (see orchestrator.fix-capture.test.ts and
    // server.runfullcycle.test.ts), not a setup bug. It must not throw.
    const featureDir = path.join(root, 'features', 'demo')
    const serviceRepo = path.join(featureDir, 'services', 'api')
    const settingsPath = writeHealAgentIsolationSettings({
      runDir: path.join(root, 'run'),
      writableDirs: [serviceRepo],
      featureDir,
      featureDirReadOnly: true,
      worktrees: [],
    })
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

    expect(settings.permissions.deny).toEqual([])
    expect(settings.sandbox.filesystem.allowWrite).toEqual([serviceRepo])
    expect(settings.sandbox.filesystem.denyWrite).toEqual([])
  })

  it('rejects a worktree handle whose local path is the immediate parent of its worktree root', () => {
    // A handle this internally inconsistent would otherwise make
    // canonicalLocalPath silently compute a bogus "source" path that does not
    // correspond to the repo at all, defeating the deny list built from it.
    const worktreeRoot = path.join(root, 'nested', 'worktree')
    const localPath = path.join(root, 'nested')
    expect(() => writeHealAgentIsolationSettings({
      runDir: path.join(root, 'run'),
      writableDirs: [localPath],
      featureDir: path.join(root, 'features', 'checkout'),
      featureDirReadOnly: true,
      worktrees: [{ repoName: 'app', sourceRoot: path.join(root, 'source'), worktreeRoot, localPath }],
    })).toThrow(/worktree path for "app" escapes its worktree root/)
  })

  it('rejects a worktree handle whose local path sits outside its worktree root entirely', () => {
    const worktreeRoot = path.join(root, 'worktree')
    const localPath = path.join(root, 'elsewhere')
    expect(() => writeHealAgentIsolationSettings({
      runDir: path.join(root, 'run'),
      writableDirs: [localPath],
      featureDir: path.join(root, 'features', 'checkout'),
      featureDirReadOnly: true,
      worktrees: [{ repoName: 'app', sourceRoot: path.join(root, 'source'), worktreeRoot, localPath }],
    })).toThrow(/worktree path for "app" escapes its worktree root/)
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
