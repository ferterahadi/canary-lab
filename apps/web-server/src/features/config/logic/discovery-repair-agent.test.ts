import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDiscoveryRepairAgent } from './discovery-repair-agent'
import type { DiscoveryRepair } from '../../../../../../shared/discovery-repair'
import type { RunAgentProcessOpts, AgentProcessResult } from '../../agent-sessions/logic/agent-process'

// One I/O edge is faked: the CLI subprocess. Everything this module owns — which
// argv shape each agent gets, which directories the spawn may read, where the
// transcript is teed, and what a non-zero exit means — runs for real.
const amock = vi.hoisted(() => ({
  calls: [] as RunAgentProcessOpts[],
  result: { code: 0, signal: null, stopped: false } as AgentProcessResult,
  /** Text the fake CLI emits before exiting, so the onChunk tee is exercised. */
  chunk: null as string | null,
}))
vi.mock('../../agent-sessions/logic/agent-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-sessions/logic/agent-process')>()
  return {
    ...actual,
    runAgentProcess: vi.fn((opts: RunAgentProcessOpts) => {
      amock.calls.push(opts)
      if (amock.chunk) opts.onChunk?.(amock.chunk, 'stdout')
      return { child: { kill: vi.fn() }, done: Promise.resolve({ ...amock.result }), stop: vi.fn() }
    }),
  }
})

let root: string
let featureDir: string
let recordDir: string

function repair(over: Partial<DiscoveryRepair> = {}): DiscoveryRepair {
  const now = '2026-09-10T00:00:00.000Z'
  return {
    id: `dr_${'a'.repeat(24)}`,
    feature: 'suite',
    featureDir,
    status: 'repairing',
    owner: { kind: 'internal', agent: 'claude' },
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    message: 'Repairing discovery',
    diagnostic: 'missing import',
    log: [],
    promptPath: path.join(recordDir, 'prompt.md'),
    ...over,
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-agent-')))
  featureDir = path.join(root, 'features', 'suite')
  recordDir = path.join(root, 'logs', 'discovery-repairs', 'dr-1')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(recordDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'product'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'suite', featureDir: __dirname, repos: [{ name: 'product', localPath: ${JSON.stringify(path.join(root, 'product'))} }, { name: 'gone', localPath: ${JSON.stringify(path.join(root, 'not-cloned'))} }], envs: [] } }`)
  fs.writeFileSync(path.join(recordDir, 'prompt.md'), 'Fix test discovery.')
  amock.calls.length = 0
  amock.result = { code: 0, signal: null, stopped: false }
  amock.chunk = null
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('runDiscoveryRepairAgent', () => {
  it('gives claude a fresh session id, the prompt in argv, and read access to the workspace, the suite and every cloned repo', async () => {
    const onSession = vi.fn()
    await runDiscoveryRepairAgent(repair(), root, onSession)
    expect(onSession).toHaveBeenCalledWith({ agent: 'claude', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    const spawn = amock.calls[0]
    expect(spawn.command).toBe('claude')
    expect(spawn.args).toContain('Fix test discovery.')
    expect(spawn.stdin).toBeUndefined()
    expect(spawn.cwd).toBe(recordDir)
    // The uncloned repo is dropped: `--add-dir` on a missing path is an error,
    // not a no-op, and would take the whole spawn down.
    expect(spawn.args.filter((a, i) => spawn.args[i - 1] === '--add-dir'))
      .toEqual([root, featureDir, path.join(root, 'product')])
    expect(spawn.args).not.toContain(path.join(root, 'not-cloned'))
  })

  it('gives codex the prompt on stdin instead, with no session id to pin', async () => {
    const onSession = vi.fn()
    await runDiscoveryRepairAgent(repair({ owner: { kind: 'internal', agent: 'codex' } }), root, onSession)
    expect(onSession).toHaveBeenCalledWith({ agent: 'codex', sessionId: '' })
    const spawn = amock.calls[0]
    expect(spawn.command).toBe('codex')
    expect(spawn.stdin).toBe('Fix test discovery.')
    expect(spawn.args.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write'])
    expect(spawn.args).not.toContain('Fix test discovery.')
  })

  it('tees the agent transcript beside the prompt so the activity rail has a file to tail', async () => {
    amock.chunk = 'reading the spec\n'
    await runDiscoveryRepairAgent(repair(), root, vi.fn())
    expect(fs.readFileSync(path.join(recordDir, 'agent-output.log'), 'utf8')).toBe('reading the spec\n')
  })

  it('still spawns when the suite config has gone missing, adding only the paths it can name', async () => {
    fs.rmSync(path.join(featureDir, 'feature.config.cjs'))
    await runDiscoveryRepairAgent(repair(), root, vi.fn())
    expect(amock.calls[0].args.filter((a, i) => amock.calls[0].args[i - 1] === '--add-dir')).toEqual([root, featureDir])
  })

  it('refuses to spawn for a repair an external agent owns', async () => {
    await expect(runDiscoveryRepairAgent(repair({ owner: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } }), root, vi.fn()))
      .rejects.toThrow('An external repair cannot spawn an internal agent')
    expect(amock.calls).toEqual([])
  })

  it.each([
    { name: 'a signal', result: { code: null, signal: 'SIGTERM', stopped: false }, reason: 'SIGTERM' },
    { name: 'a non-zero exit', result: { code: 2, signal: null, stopped: false }, reason: '2' },
    { name: 'a stop with no exit information at all', result: { code: null, signal: null, stopped: true }, reason: 'unknown exit' },
  ])('treats %s as an unfinished repair rather than a verdict', async ({ result, reason }) => {
    amock.result = result as AgentProcessResult
    await expect(runDiscoveryRepairAgent(repair(), root, vi.fn()))
      .rejects.toThrow(`Repair agent stopped (${reason}). Review its activity before retrying.`)
  })
})
