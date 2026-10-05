import type { ProjectConfigResponse } from '@shared/project-config'
// @vitest-environment happy-dom
import type { OnboardingSamples } from '@shared/getting-started'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DemoLauncher } from './demo-launcher'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The derivation (`deriveDemoAvailability`, `demoFlightLaunch`, the seen flag) is
// covered against the real rules in demo-launcher.test.ts. This suite owns what
// the hook adds: three fetches, the fallback poll, the invalidation-keyed
// refetches, and the optimistic `showDemo` write that has to revert on failure.
// The client barrel is mocked because there is no server here; the invalidation
// context is mocked so a bump can be simulated without a provider tree.
const api = vi.hoisted(() => ({
  getOnboardingSamples: vi.fn(),
  getProjectConfig: vi.fn(),
  putProjectConfig: vi.fn(),
}))
vi.mock('@/shared/api/config', () => ({
  getOnboardingSamples: api.getOnboardingSamples,
  getProjectConfig: api.getProjectConfig,
  putProjectConfig: api.putProjectConfig,
}))

const keys = { onboarding: 0, 'project-config': 0 } as Record<string, number>
vi.mock('@/shared/state/invalidation', () => ({ useInvalidationKey: (topic: string) => keys[topic] ?? 0 }))

const { useDemoLauncher } = await import('./demo-launcher')

function samples(over: Partial<OnboardingSamples> = {}): OnboardingSamples {
  return {
    sampleSuite: 'storefront-journey',
    sampleFlightRepo: '/w/flight-app',
    sampleFlightDescription: 'the ordering flow',
    workflows: [],
    session: { active: null, completed: {} },
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let launcher: DemoLauncher

function Probe() {
  launcher = useDemoLauncher([], [])
  return null
}

async function mount(): Promise<void> {
  await act(async () => { root.render(<Probe />) })
}

/** Re-render so the mocked invalidation keys are re-read. */
async function rerender(): Promise<void> {
  await act(async () => { root.render(<Probe key={`${keys.onboarding}-${keys['project-config']}`} />) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  keys.onboarding = 0
  keys['project-config'] = 0
  api.getOnboardingSamples.mockReset().mockResolvedValue(samples())
  api.getProjectConfig.mockReset().mockResolvedValue({ showDemo: true } as ProjectConfigResponse)
  api.putProjectConfig.mockReset().mockImplementation(async (patch) => ({ showDemo: true, ...patch }))
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('useDemoLauncher', () => {
  it('serves the workspace catalog and the derived availability', async () => {
    await mount()

    expect(launcher.suite).toBe('storefront-journey')
    expect(launcher.available).toBe(true)
    expect(launcher.hasSamples).toBe(true)
    expect(launcher.unseen).toBe(true)
    expect(launcher.autoOpen).toBe(true)
    expect(launcher.showDemo).toBe(true)
  })

  it('stays silent on a server with no onboarding route', async () => {
    api.getOnboardingSamples.mockRejectedValue(new Error('404'))
    api.getProjectConfig.mockRejectedValue(new Error('404'))

    await mount()

    expect(launcher.suite).toBeNull()
    expect(launcher.workflows).toEqual([])
    expect(launcher.session).toEqual({ active: null, completed: {} })
    expect(launcher.showDemo).toBeNull()
    expect(launcher.available).toBe(false)
  })

  it('treats an explicit showDemo:false as the pill being turned off', async () => {
    api.getProjectConfig.mockResolvedValue({ showDemo: false } as ProjectConfigResponse)

    await mount()

    expect(launcher.showDemo).toBe(false)
    expect(launcher.available).toBe(false)
    expect(launcher.unseen).toBe(false)
  })

  it('marks the chooser seen durably, clearing the dot and the auto-open', async () => {
    await mount()

    await act(async () => { launcher.markSeen() })

    expect(launcher.unseen).toBe(false)
    expect(launcher.autoOpen).toBe(false)
    expect(window.localStorage.getItem('canary-lab:demo-seen')).toBe('1')
  })

  it('refetches the catalog when the onboarding slot is bumped', async () => {
    await mount()
    api.getOnboardingSamples.mockResolvedValue(samples({ sampleSuite: 'other-suite' }))

    keys.onboarding = 1
    await rerender()

    expect(launcher.suite).toBe('other-suite')
  })

  it('refetches the config when the project-config slot is bumped', async () => {
    await mount()
    api.getProjectConfig.mockResolvedValue({ showDemo: false } as ProjectConfigResponse)

    keys['project-config'] = 1
    await rerender()

    expect(launcher.showDemo).toBe(false)
  })

  it('polls the catalog so a dropped push still surfaces an external start', async () => {
    vi.useFakeTimers()
    await mount()
    const afterMount = api.getOnboardingSamples.mock.calls.length
    api.getOnboardingSamples.mockResolvedValue(samples({ sampleSuite: 'polled-suite' }))

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

    expect(api.getOnboardingSamples.mock.calls.length).toBe(afterMount + 1)
    expect(launcher.suite).toBe('polled-suite')

    // A failed poll is ignored rather than blanking the catalog.
    api.getOnboardingSamples.mockRejectedValue(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(launcher.suite).toBe('polled-suite')
  })

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers()
    await mount()
    act(() => { root.unmount() })
    const afterUnmount = api.getOnboardingSamples.mock.calls.length

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    expect(api.getOnboardingSamples.mock.calls.length).toBe(afterUnmount)
  })

  it('drops both initial responses that land after unmount', async () => {
    let settleSamples: (value: OnboardingSamples) => void = () => {}
    let settleConfig: (value: ProjectConfigResponse) => void = () => {}
    api.getOnboardingSamples.mockReturnValue(new Promise((r) => { settleSamples = r }))
    api.getProjectConfig.mockReturnValue(new Promise((r) => { settleConfig = r }))

    await mount()
    act(() => { root.unmount() })
    await act(async () => {
      settleSamples(samples({ sampleSuite: 'late' }))
      settleConfig({ showDemo: true } as ProjectConfigResponse)
    })

    // The `alive` guards are the point: no setState after unmount, so the last
    // snapshot the probe returned still reads unloaded.
    expect(launcher.suite).toBeNull()
    expect(launcher.showDemo).toBeNull()
  })

  it('writes a showDemo change through optimistically', async () => {
    await mount()

    await act(async () => { launcher.setShowDemo(false) })

    expect(api.putProjectConfig).toHaveBeenCalledWith({ showDemo: false })
    expect(launcher.showDemo).toBe(false)
  })

  it('reverts the checkbox when the config cannot be written', async () => {
    api.putProjectConfig.mockRejectedValue(new Error('read-only config'))
    await mount()
    expect(launcher.showDemo).toBe(true)

    await act(async () => { launcher.setShowDemo(false) })

    // A box left ticked would lie about what is on disk.
    expect(launcher.showDemo).toBe(true)
  })
})

it('serializes visibility writes and preserves the newest optimistic choice', async () => {
  let finish!: (value: ProjectConfigResponse) => void
  api.putProjectConfig.mockReturnValueOnce(new Promise((yes) => { finish = yes }))
  await mount()
  await act(async () => { launcher.setShowDemo(false); launcher.setShowDemo(true) })
  expect(api.putProjectConfig).toHaveBeenCalledTimes(1)
  expect(launcher.showDemo).toBe(true)
  await act(async () => { finish({ showDemo: false } as ProjectConfigResponse) })
  expect(api.putProjectConfig.mock.calls).toEqual([[{ showDemo: false }], [{ showDemo: true }]])
  expect(launcher.showDemo).toBe(true)
})

it('failed visibility writes reveal the latest accepted configuration and teardown cancels queued writes', async () => {
  vi.useFakeTimers()
  let fail!: (error: Error) => void
  api.putProjectConfig.mockReturnValueOnce(new Promise((_, no) => { fail = no }))
  await mount()
  await act(async () => { launcher.setShowDemo(false) })
  api.getProjectConfig.mockResolvedValue({ showDemo: false } as ProjectConfigResponse)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); fail(new Error('offline')) })
  expect(launcher.showDemo).toBe(false)
  let finish!: (value: ProjectConfigResponse) => void
  api.putProjectConfig.mockReturnValueOnce(new Promise((yes) => { finish = yes }))
  await act(async () => { launcher.setShowDemo(true); launcher.setShowDemo(false) })
  await act(async () => { root.render(null) })
  await act(async () => { finish({ showDemo: true } as ProjectConfigResponse); await vi.advanceTimersByTimeAsync(10000) })
  expect(api.putProjectConfig).toHaveBeenCalledTimes(2)
})


it('rejects a retired visibility action and a rejected in-flight write after teardown', async () => {
  let fail!: (error: Error) => void
  api.putProjectConfig.mockReturnValueOnce(new Promise((_, no) => { fail = no }))
  await mount()
  const retired = launcher.setShowDemo
  await act(async () => retired(false))
  await act(async () => root.render(null))
  await act(async () => { fail(new Error('offline')); retired(true) })
  expect(api.putProjectConfig).toHaveBeenCalledTimes(1)
})
