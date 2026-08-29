// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useRunStart, type UseRunStart, type UseRunStartDeps } from './use-run-start'

const mocks = vi.hoisted(() => ({
  asRepoCollision: vi.fn(),
  asBranchMismatch: vi.fn(),
  benchmarkPreflight: vi.fn(),
  checkoutRepoBranch: vi.fn(),
  pinFeatureBranchesToCurrent: vi.fn(),
  getProjectConfig: vi.fn(),
}))
vi.mock('@/shared/api/client', () => ({
  asRepoCollision: mocks.asRepoCollision,
  asBranchMismatch: mocks.asBranchMismatch,
  benchmarkPreflight: mocks.benchmarkPreflight,
  checkoutRepoBranch: mocks.checkoutRepoBranch,
  pinFeatureBranchesToCurrent: mocks.pinFeatureBranchesToCurrent,
  getProjectConfig: mocks.getProjectConfig,
}))

let hook: UseRunStart
function Harness(props: UseRunStartDeps) {
  hook = useRunStart(props)
  return null
}

let container: HTMLDivElement
let root: Root
let startRun: Mock<UseRunStartDeps['startRun']>
let startVerification: Mock<UseRunStartDeps['startVerification']>
let onRunStarted: Mock<UseRunStartDeps['onRunStarted']>

function mount(over: Partial<UseRunStartDeps> = {}) {
  const deps: UseRunStartDeps = {
    selectedFeature: 'checkout',
    startRun,
    startVerification,
    onRunStarted,
    ...over,
  }
  act(() => root.render(<Harness {...deps} />))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  startRun = vi.fn<UseRunStartDeps['startRun']>().mockResolvedValue('run-1')
  startVerification = vi.fn<UseRunStartDeps['startVerification']>().mockResolvedValue('verify-1')
  onRunStarted = vi.fn<UseRunStartDeps['onRunStarted']>()
  mocks.asRepoCollision.mockReset().mockReturnValue(null)
  mocks.asBranchMismatch.mockReset().mockReturnValue(null)
  mocks.benchmarkPreflight.mockReset().mockResolvedValue({ portsConfigured: true })
  mocks.checkoutRepoBranch.mockReset().mockResolvedValue(undefined)
  mocks.pinFeatureBranchesToCurrent.mockReset().mockResolvedValue(undefined)
  // The models gate probes the config before a test run — defaults disarm it.
  mocks.getProjectConfig.mockReset().mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('handleStartRun', () => {
  it('selects the started run on success', async () => {
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'test', undefined)
    expect(onRunStarted).toHaveBeenCalledWith('run-1')
    expect(hook.collisionPrompt).toBeNull()
    expect(hook.startError).toBeNull()
  })

  it('does NOT select a boot run (Services overlay owns it)', async () => {
    mount()
    await act(async () => { await hook.handleStartRun('local', 'boot') })
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'boot', undefined)
    expect(onRunStarted).not.toHaveBeenCalled()
  })

  it('no-ops when no feature is selected', async () => {
    mount({ selectedFeature: null })
    await act(async () => { await hook.handleStartRun('local') })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('raises the collision prompt (with ports flag) on a same-repo 409', async () => {
    const info = { repo: 'shop', activeRunId: 'run-0' }
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValue(info)
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.collisionPrompt).toMatchObject({ feature: 'checkout', env: 'local', mode: 'test', info, portsConfigured: true })
    expect(onRunStarted).not.toHaveBeenCalled()
    expect(hook.startError).toBeNull()
  })

  it('still prompts when the ports probe fails (best-effort flag stays undefined)', async () => {
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValue({ repo: 'shop' })
    mocks.benchmarkPreflight.mockRejectedValue(new Error('probe down'))
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.collisionPrompt).toMatchObject({ feature: 'checkout', portsConfigured: undefined })
  })

  it('surfaces any non-collision failure as a start error', async () => {
    const err = new Error('boom')
    startRun.mockRejectedValueOnce(err)
    mocks.asRepoCollision.mockReturnValue(null)
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.startError).toMatchObject({ feature: 'checkout', env: 'local', mode: 'test', error: err })
    expect(hook.collisionPrompt).toBeNull()
  })
})

describe('resolveCollision', () => {
  it('re-issues the start with the chosen isolation and clears the prompt', async () => {
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValue({ repo: 'shop' })
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.collisionPrompt).not.toBeNull()

    await act(async () => { await hook.resolveCollision('worktree') })
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', 'worktree', 'test', undefined)
    expect(onRunStarted).toHaveBeenCalledWith('run-1')
    expect(hook.collisionPrompt).toBeNull()
  })

  it('surfaces a failure of the isolated retry as a start error', async () => {
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValue({ repo: 'shop' })
    mount()
    await act(async () => { await hook.handleStartRun('local', 'boot') })
    startRun.mockRejectedValueOnce(new Error('no disk space for a worktree'))

    await act(async () => { await hook.resolveCollision('worktree') })

    // The retry carries the ORIGINAL mode through, so the error dialog's own
    // replay can't silently turn a boot into a test run.
    expect(hook.startError).toMatchObject({ feature: 'checkout', env: 'local', mode: 'boot' })
    expect(hook.collisionPrompt).toBeNull()
  })

  it('does NOT select an isolated boot run either', async () => {
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValue({ repo: 'shop' })
    mount()
    await act(async () => { await hook.handleStartRun('local', 'boot') })

    await act(async () => { await hook.resolveCollision('queue') })

    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', 'queue', 'boot', undefined)
    expect(onRunStarted).not.toHaveBeenCalled()
  })

  it('does nothing when there is no prompt to resolve', async () => {
    mount()

    await act(async () => { await hook.resolveCollision('queue') })

    expect(startRun).not.toHaveBeenCalled()
    expect(hook.startError).toBeNull()
  })
})

describe('branch-mismatch recovery', () => {
  it('switchBranchesAndRun checks out each repo then replays the start', async () => {
    const err = new Error('branch mismatch')
    startRun.mockRejectedValueOnce(err)
    mocks.asRepoCollision.mockReturnValue(null)
    mocks.asBranchMismatch.mockReturnValue({ repos: [{ name: 'shop', expected: 'main' }, { name: 'api', expected: 'dev' }] })
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.startError).not.toBeNull()

    await act(async () => { await hook.switchBranchesAndRun() })
    expect(mocks.checkoutRepoBranch).toHaveBeenCalledWith('checkout', 'shop', 'main')
    expect(mocks.checkoutRepoBranch).toHaveBeenCalledWith('checkout', 'api', 'dev')
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', undefined, 'test', undefined)
    expect(hook.startError).toBeNull()
  })

  it('pinCurrentAndRun pins the branches then replays the start', async () => {
    startRun.mockRejectedValueOnce(new Error('branch mismatch'))
    mount()
    await act(async () => { await hook.handleStartRun('local') })

    await act(async () => { await hook.pinCurrentAndRun() })
    expect(mocks.pinFeatureBranchesToCurrent).toHaveBeenCalledWith('checkout')
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', undefined, 'test', undefined)
    expect(hook.startError).toBeNull()
  })

  it('does nothing when there is no start error to recover from', async () => {
    mount()

    await act(async () => {
      await hook.switchBranchesAndRun()
      await hook.pinCurrentAndRun()
    })

    // Both are dialog buttons; the dialog is only up while an error is held, so
    // a stray call must not pin branches or replay a start on its own.
    expect(mocks.checkoutRepoBranch).not.toHaveBeenCalled()
    expect(mocks.pinFeatureBranchesToCurrent).not.toHaveBeenCalled()
    expect(startRun).not.toHaveBeenCalled()
  })

  it('leaves a non-mismatch error alone rather than checking anything out', async () => {
    startRun.mockRejectedValueOnce(new Error('playwright is not installed'))
    mocks.asBranchMismatch.mockReturnValue(null)
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    const held = hook.startError

    await act(async () => { await hook.switchBranchesAndRun() })

    expect(mocks.checkoutRepoBranch).not.toHaveBeenCalled()
    expect(hook.startError).toBe(held)
  })
})

describe('handleStartVerification', () => {
  it('starts a verification and selects the resulting run', async () => {
    mount()
    await act(async () => { await hook.handleStartVerification({ configId: 'cfg-1' }) })
    expect(startVerification).toHaveBeenCalledWith('checkout', { configId: 'cfg-1' })
    expect(onRunStarted).toHaveBeenCalledWith('verify-1')
  })

  it('no-ops when no feature is selected', async () => {
    mount({ selectedFeature: null })

    await act(async () => { await hook.handleStartVerification({ configId: 'cfg-1' }) })

    expect(startVerification).not.toHaveBeenCalled()
  })
})

describe('models gate (askModelsOnLaunch)', () => {
  const armed = { healAgent: 'claude' as const, editor: 'auto' as const, personalWikiPath: null, askModelsOnLaunch: true, agentModels: { claude: { heal: { model: 'opus', effort: 'high' } }, codex: {} } }

  it('parks a test run on the gate instead of starting, in the heal agent\'s vocabulary', async () => {
    mocks.getProjectConfig.mockResolvedValue({ ...armed, healAgent: 'codex' })
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(startRun).not.toHaveBeenCalled()
    expect(hook.modelsPrompt).toMatchObject({ feature: 'checkout', env: 'local', mode: 'test', agent: 'codex' })
    expect(hook.modelsPrompt?.agentModels).toEqual(armed.agentModels)
  })

  it('maps every non-codex healAgent to the claude vocabulary', async () => {
    mocks.getProjectConfig.mockResolvedValue({ ...armed, healAgent: 'auto' })
    mount()
    await act(async () => { await hook.handleStartRun() })
    expect(hook.modelsPrompt?.agent).toBe('claude')
  })

  it('a config with no agentModels block gates with empty plans (pre-2.2.0 workspace)', async () => {
    mocks.getProjectConfig.mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null, askModelsOnLaunch: true })
    mount()
    await act(async () => { await hook.handleStartRun() })
    expect(hook.modelsPrompt?.agentModels).toEqual({ claude: {}, codex: {} })
  })

  it('boot runs skip the gate — they spawn no heal/commit agents', async () => {
    mocks.getProjectConfig.mockResolvedValue(armed)
    mount()
    await act(async () => { await hook.handleStartRun('local', 'boot') })
    expect(mocks.getProjectConfig).not.toHaveBeenCalled()
    expect(hook.modelsPrompt).toBeNull()
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'boot', undefined)
  })

  it('starts with defaults when the config probe fails — the gate never blocks a run', async () => {
    mocks.getProjectConfig.mockRejectedValue(new Error('down'))
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(hook.modelsPrompt).toBeNull()
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'test', undefined)
  })

  it('confirming the defaults card sends NO models — the server resolves config', async () => {
    mocks.getProjectConfig.mockResolvedValue(armed)
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    await act(async () => { await hook.resolveModelsPrompt(null) })
    expect(hook.modelsPrompt).toBeNull()
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'test', undefined)
    expect(onRunStarted).toHaveBeenCalledWith('run-1')
  })

  it('confirming a customized plan rides it on the start', async () => {
    mocks.getProjectConfig.mockResolvedValue(armed)
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    const plan = { heal: { model: 'haiku', effort: 'low' } }
    await act(async () => { await hook.resolveModelsPrompt(plan) })
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'test', plan)
  })

  it('resolveModelsPrompt without a parked prompt is a no-op', async () => {
    mount()
    await act(async () => { await hook.resolveModelsPrompt(null) })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('the gate answer survives a collision retry — the user is not re-asked', async () => {
    mocks.getProjectConfig.mockResolvedValue(armed)
    const plan = { heal: { model: 'haiku', effort: 'low' } }
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    startRun.mockRejectedValueOnce(new Error('409'))
    mocks.asRepoCollision.mockReturnValueOnce({ repo: 'shop' })
    await act(async () => { await hook.resolveModelsPrompt(plan) })
    expect(hook.collisionPrompt).toMatchObject({ feature: 'checkout', models: plan })
    await act(async () => { await hook.resolveCollision('worktree') })
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', 'worktree', 'test', plan)
  })

  it('retryStartError replays the exact failed start — feature and gate answer included', async () => {
    mocks.getProjectConfig.mockResolvedValue(armed)
    const plan = { heal: { model: 'haiku', effort: 'low' } }
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    startRun.mockRejectedValueOnce(new Error('500'))
    await act(async () => { await hook.resolveModelsPrompt(plan) })
    expect(hook.startError).toMatchObject({ feature: 'checkout', models: plan })
    await act(async () => { await hook.retryStartError() })
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', undefined, 'test', plan)
    expect(hook.startError).toBeNull()
  })

  it('retryStartError without a start error is a no-op', async () => {
    mount()
    await act(async () => { await hook.retryStartError() })
    expect(startRun).not.toHaveBeenCalled()
  })
})
