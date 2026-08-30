import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const resolvePath = vi.hoisted(() => vi.fn((value: string) => value))

vi.mock('../../../../shared/launcher-startup', async (importActual) => {
  const actual = await importActual<typeof import('../../../../shared/launcher-startup')>()
  return { ...actual, resolvePath }
})

import { spawnHealAgentRepl } from './run-heal-agent'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { PtyFactory, PtyHandle } from './pty-spawner'

let root: string

afterEach(() => {
  vi.clearAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('spawnHealAgentRepl declared repository fallback', () => {
  it('resolves localPath when no worktree override is present', () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-agent-fallback-')))
    const sourceRoot = path.join(root, 'source')
    const featureDir = path.join(root, 'features', 'demo')
    fs.mkdirSync(sourceRoot, { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    const ptyFactory: PtyFactory = () => ({
      pid: 4242,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as unknown as PtyHandle)
    const buildSpawnCommand = vi.fn(() => 'codex')
    const { ctx } = makeHealLoopContext({
      root,
      opts: { ptyFactory, autoHeal: { agent: 'codex', maxCycles: 1, buildSpawnCommand } } as never,
      state: {
        feature: {
          name: 'demo', description: 'demo', envs: ['local'], featureDir,
          repos: [{ name: 'api', localPath: sourceRoot, startCommands: [] }],
        },
        repoPathOverrides: {},
      } as never,
    })
    fs.mkdirSync(ctx.runDir, { recursive: true })

    spawnHealAgentRepl(ctx)

    expect(resolvePath).toHaveBeenCalledWith(sourceRoot)
    expect(buildSpawnCommand).toHaveBeenCalledWith(expect.objectContaining({ writableDirs: [sourceRoot] }))
  })
})
