// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunStart, type UseRunStart, type UseRunStartDeps } from './use-run-start'

const mocks = vi.hoisted(() => ({
  asRepoCollision: vi.fn(),
  asBranchMismatch: vi.fn(),
  benchmarkPreflight: vi.fn(),
  checkoutRepoBranch: vi.fn(),
  pinFeatureBranchesToCurrent: vi.fn(),
}))
vi.mock('../../../shared/api/client', () => ({
  asRepoCollision: mocks.asRepoCollision,
  asBranchMismatch: mocks.asBranchMismatch,
  benchmarkPreflight: mocks.benchmarkPreflight,
  checkoutRepoBranch: mocks.checkoutRepoBranch,
  pinFeatureBranchesToCurrent: mocks.pinFeatureBranchesToCurrent,
}))

let hook: UseRunStart
function Harness(props: UseRunStartDeps) {
  hook = useRunStart(props)
  return null
}

let container: HTMLDivElement
let root: Root
let startRun: ReturnType<typeof vi.fn>
let startVerification: ReturnType<typeof vi.fn>
let onRunStarted: ReturnType<typeof vi.fn>

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
  startRun = vi.fn().mockResolvedValue('run-1')
  startVerification = vi.fn().mockResolvedValue('verify-1')
  onRunStarted = vi.fn()
  mocks.asRepoCollision.mockReset().mockReturnValue(null)
  mocks.asBranchMismatch.mockReset().mockReturnValue(null)
  mocks.benchmarkPreflight.mockReset().mockResolvedValue({ portsConfigured: true })
  mocks.checkoutRepoBranch.mockReset().mockResolvedValue(undefined)
  mocks.pinFeatureBranchesToCurrent.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('handleStartRun', () => {
  it('selects the started run on success', async () => {
    mount()
    await act(async () => { await hook.handleStartRun('local') })
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'test')
    expect(onRunStarted).toHaveBeenCalledWith('run-1')
    expect(hook.collisionPrompt).toBeNull()
    expect(hook.startError).toBeNull()
  })

  it('does NOT select a boot run (Services overlay owns it)', async () => {
    mount()
    await act(async () => { await hook.handleStartRun('local', 'boot') })
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'boot')
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
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', 'worktree', 'test')
    expect(onRunStarted).toHaveBeenCalledWith('run-1')
    expect(hook.collisionPrompt).toBeNull()
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
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', undefined, 'test')
    expect(hook.startError).toBeNull()
  })

  it('pinCurrentAndRun pins the branches then replays the start', async () => {
    startRun.mockRejectedValueOnce(new Error('branch mismatch'))
    mount()
    await act(async () => { await hook.handleStartRun('local') })

    await act(async () => { await hook.pinCurrentAndRun() })
    expect(mocks.pinFeatureBranchesToCurrent).toHaveBeenCalledWith('checkout')
    expect(startRun).toHaveBeenLastCalledWith('checkout', 'local', undefined, 'test')
    expect(hook.startError).toBeNull()
  })
})

describe('handleStartVerification', () => {
  it('starts a verification and selects the resulting run', async () => {
    mount()
    await act(async () => { await hook.handleStartVerification({ configId: 'cfg-1' }) })
    expect(startVerification).toHaveBeenCalledWith('checkout', { configId: 'cfg-1' })
    expect(onRunStarted).toHaveBeenCalledWith('verify-1')
  })
})
