// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import { GlobalStatusBar } from './GlobalStatusBar'
import type { TestReviewReceipt } from '@shared/test-review'
import type { RunDetail } from '../api/types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getMcpHealth: vi.fn(),
    getFeatureTests: vi.fn().mockResolvedValue([{ file: 'test.ts', tests: [{}, {}, {}] }]),
  }
})

const mockActiveRuns = vi.hoisted(() => ({ value: { runs: [] as unknown[], count: 0 } }))
const mockRuns = vi.hoisted(() => ({ value: [] as unknown[] }))
const mockBootSessions = vi.hoisted(() => ({ value: { sessions: [] as unknown[], count: 0 } }))
const mockVerifyRuns = vi.hoisted(() => ({ value: { runs: [] as unknown[], count: 0 } }))
const acceptance = vi.hoisted(() => ({ enabled: false, status: 'new-run-required' as TestReviewReceipt['execution']['status'] }))
vi.mock('@/features/runs/components/DirtyReviewDialog', async (original) => {
  const actual = await original<typeof import('@/features/runs/components/DirtyReviewDialog')>()
  return { DirtyReviewDialog: (props: Parameters<typeof actual.DirtyReviewDialog>[0]) => !acceptance.enabled ? <actual.DirtyReviewDialog {...props} /> : <button onClick={() => {
    const { onAccepted, onClose } = props
    onClose()
    const receipt: TestReviewReceipt = {
      decision: 'accepted', review_revision: 'a'.repeat(64), files: ['e2e/test.spec.ts'],
      at: '2026-09-22T15:28:47.000Z', git: { status: 'committed', commit: 'b'.repeat(40) },
      execution: acceptance.status === 'none' ? { status: 'none' } : { status: acceptance.status, runId: 'old' },
    }
    onAccepted?.('alpha', receipt, { summary: { passed: 7, total: 8 } } as RunDetail)
  }}>Accept fixture</button>,
  }
})

vi.mock('@/features/runs/state/RunsContext', () => ({
  useRuns: () => ({ connection: 'live', runs: mockRuns.value, abort: vi.fn() }),
  useActiveRuns: () => mockActiveRuns.value,
  useActiveBootSessions: () => mockBootSessions.value,
  useActiveVerifyRuns: () => mockVerifyRuns.value,
  useRun: () => ({ detail: undefined, status: undefined, transient: null }),
  useRunDetails: () => ({}),
}))

vi.mock('@/features/benchmark/state/BenchmarkContext', () => ({
  useBenchmarks: () => ({ benchmarks: [], connection: 'live', startBenchmark: vi.fn(), abortBenchmark: vi.fn(), loadBenchmark: vi.fn() }),
}))

vi.mock('@/features/benchmark/components/BenchmarkWindow', () => ({
  BenchmarkWindow: () => null,
}))

vi.mock('@/features/wizard/components/WizardTaskStatus', () => ({
  WizardTaskStatus: () => null,
}))

vi.mock('@/features/evaluation/components/EvaluationExportTaskToast', () => ({
  EvaluationExportDialogHost: () => null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  acceptance.status = 'new-run-required'
  acceptance.enabled = false
  mockActiveRuns.value = { runs: [], count: 0 }
  mockRuns.value = []
  mockBootSessions.value = { sessions: [], count: 0 }
  mockVerifyRuns.value = { runs: [], count: 0 }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.removeItem('cl-mcp-connect-open')
  vi.mocked(api.getMcpHealth).mockImplementation(async () => {
    const profile = 'compact'
    const tools = ['exec']
    return {
      ok: true,
      server: { name: 'canary-lab' },
      profile,
      clientKind: 'other',
      toolCount: tools.length,
      tools,
      activeSessions: 0,
      projectRoot: '/Users/dev/Documents/canary-lab-workspace',
    }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

function runsButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Show all runs')) as HTMLButtonElement | undefined
}

it('shows dynamic committed-source feedback, dismisses before normal run action, and emits no follow-up toast', async () => {
  acceptance.enabled = true
  const onRunLatestTests = vi.fn()
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} onRunLatestTests={onRunLatestTests} />))
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  const toast = document.querySelector('[data-testid="toast-test-review-accepted"]')!
  expect(toast.textContent).toContain('Current source: 3 tests. The selected 7/8 run is historical.')
  expect(toast.textContent).toContain('Run latest 3 tests')
  await act(async () => (toast.querySelector('button') as HTMLButtonElement).click())
  expect(onRunLatestTests).toHaveBeenCalledExactlyOnceWith('alpha')
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Run started')
})

it('dismisses acceptance feedback without starting a run', async () => {
  acceptance.enabled = true
  const onRunLatestTests = vi.fn()
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} onRunLatestTests={onRunLatestTests} />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  await act(async () => (document.querySelector('[data-testid="toast-test-review-accepted"] [aria-label="Dismiss"]') as HTMLButtonElement).click())
  expect(onRunLatestTests).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
})

it.each(['running', 'healing', 'queued'])('suppresses the recommendation when another run is %s', async (status) => {
  acceptance.enabled = true
  mockRuns.value = [{ runId: 'other', feature: 'other', status }]
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
})

it.each(['rerun-requested', 'none'] as const)('suppresses feedback when acceptance execution is %s', async (status) => {
  acceptance.enabled = true
  acceptance.status = status
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
})

it.each(['running', 'healing', 'queued'] as const)('suppresses the recommendation when the run detail is %s before the index hydrates', async (status) => {
  acceptance.enabled = true
  const activeRunDetail = { manifest: { runId: 'active', feature: 'other', status } } as RunDetail
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={activeRunDetail} review={{ open: true }} />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
})

it('suppresses the recommendation while an existing run request is continuing', async () => {
  acceptance.enabled = true
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} runStartPending />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
})

it('uses honest generic wording when current source cannot be read', async () => {
  acceptance.enabled = true
  vi.mocked(api.getFeatureTests).mockRejectedValueOnce(new Error('Unavailable'))
  await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ open: true }} onRunLatestTests={vi.fn()} />))
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept fixture')!.click())
  expect(document.querySelector('[data-testid="toast-test-review-accepted"]')?.textContent).toContain('Current source changes are committed.')
  expect(document.querySelector('[data-testid="toast-test-review-accepted"]')?.textContent).toContain('Run latest tests')
})

function servicesButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Show booted services')) as HTMLButtonElement | undefined
}

function benchmarkButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Benchmark')) as HTMLButtonElement | undefined
}

describe('GlobalStatusBar', () => {
  it('R26: no standalone Runs button — a live run lights the Flights pill instead', async () => {
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          flightPill={{ flights: [], onOpenFlight: vi.fn(), activity: new Map([['checkout', { kind: 'running', runId: 'r1' }]]) }}
        />,
      )
    })
    expect(runsButton()).toBeUndefined()
    const pill = container.querySelector('[data-testid="flights-pill"]')
    expect(pill?.textContent).toContain('Flights · 1 active')
  })

  it('counts portify/authoring activity in the Flights pill even with zero flights', async () => {
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          flightPill={{ flights: [], onOpenFlight: vi.fn(), activity: new Map([
            ['pay', { kind: 'portifying', workflowId: 'wf1' }],
            ['cart', { kind: 'authoring', draftId: 'd1' }],
          ]) }}
        />,
      )
    })
    expect(container.querySelector('[data-testid="flights-pill"]')?.textContent).toContain('Flights · 2 active')
  })

  it('threads each feature\'s group into the Flights pill picker (R55 grouping)', async () => {
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          flightPill={{
            flights: [], onOpenFlight: vi.fn(),
            features: [
              { name: 'checkout', group: 'shop' },
              { name: 'cart', group: 'shop' },
              { name: 'admin' },
            ],
          }}
        />,
      )
    })
    // Open the picker and confirm the grouped features collapse under their
    // shared group's disclosure while the ungrouped one stays flat.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')?.click()
    })
    expect(document.body.querySelector('[data-testid="flight-group-shop"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="not-flown-admin"]')).toBeTruthy()
  })

  it('surfaces booted services as a status chip (boots are not feature activity)', async () => {
    mockBootSessions.value = { sessions: [{}], count: 1 }
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    const svc = servicesButton()
    expect(svc).toBeTruthy()
    expect(svc?.getAttribute('aria-label')).toBe('Show booted services (1 up)')
    // R27: renamed + moved into the right action cluster as a StatusPill.
    expect(svc?.textContent).toContain('Services')
    expect(runsButton()).toBeUndefined()
  })

  it('R27: an active deploy check gets its own pill and navigates to its run', async () => {
    mockVerifyRuns.value = {
      runs: [{ runId: 'run-v1', feature: 'checkout', status: 'running', executionType: 'verify', startedAt: '', verificationConfigName: 'beta' }],
      count: 1,
    }
    const onNavigateToRun = vi.fn()
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} onNavigateToRun={onNavigateToRun} />)
    })
    const pill = [...container.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label')?.startsWith('Open deploy check'))
    expect(pill?.textContent).toContain('Deploy check')
    await act(async () => { pill?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onNavigateToRun).toHaveBeenCalledWith('checkout', 'run-v1')
  })

  it('R27: no deploy-check pill when nothing is verifying', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    expect(container.textContent).not.toContain('Deploy check')
  })

  // R83: a flight's Latest-run drill-through lands in the workspace run detail,
  // which has no close of its own — this button is the only way back.
  it('R83: offers a way back to the flight a drill-through came from', async () => {
    const onReturnToFlight = vi.fn()
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          returnToFlight={{ flightId: 'fl_abc', label: 'merchant-pass-fnb', onOpen: onReturnToFlight }}
        />,
      )
    })
    const back = container.querySelector<HTMLButtonElement>('[data-testid="return-to-flight"]')!
    const label = 'Go back to the “merchant-pass-fnb” flight.'
    expect(back.getAttribute('aria-label')).toBe(label)
    expect(back.textContent).toBe('')
    expect(container.querySelector('.cl-shell-bar')?.firstElementChild?.contains(back)).toBe(true)
    await act(async () => { back.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(label)
    await act(async () => { back.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { back.focus() })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(label)
    await act(async () => { back.click() })
    expect(onReturnToFlight).toHaveBeenCalledWith('fl_abc')
  })

  it('R83: still offers the way back when the flight index no longer names it', async () => {
    await act(async () => {
      root.render(
        <GlobalStatusBar activeRunDetail={null} returnToFlight={{ flightId: 'fl_abc', onOpen: vi.fn() }} />,
      )
    })
    expect(container.querySelector('[data-testid="return-to-flight"]')?.getAttribute('aria-label'))
      .toBe('Go back to the flight you came from.')
  })

  it('R83: no return button when the user got here on their own', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    expect(container.querySelector('[data-testid="return-to-flight"]')).toBeNull()
  })

  it('R6 consolidation: no Coverage/Portify/Services pills — the Flights pill is the per-feature entry point', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    expect(container.querySelector('[data-testid="flights-pill"]')).toBeTruthy()
    const labels = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '')
    expect(labels).not.toContain('Open Portify feature picker')
    expect(container.textContent).not.toContain('Portify')
    expect(container.textContent).not.toContain('Coverage')
    // No boots held -> no services chip either.
    expect(servicesButton()).toBeUndefined()
  })

  it('hides the Benchmark pill by default', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    expect(benchmarkButton()).toBeUndefined()
  })

  it('shows the Benchmark pill when the URL has showBenchmark=true', async () => {
    window.history.replaceState(null, '', '/?showBenchmark=true')
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    const button = benchmarkButton()
    expect(button).toBeTruthy()
    expect(button?.textContent).toContain('Benchmark')
  })

  it('replaces the Playwright chip with a collapsed MCP indicator menu', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })

    expect(container.textContent).not.toContain('Playwright')
    expect(container.textContent).toContain('MCP')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).not.toContain('12 tools')
    expect(container.textContent).not.toContain('Check health')
    expect(container.textContent).not.toContain('Test MCP')
    expect(api.getMcpHealth).toHaveBeenCalledWith()

    const indicator = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'MCP connection details')
    expect(indicator).toBeTruthy()

    await act(async () => {
      indicator?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menu = document.body.querySelector('[data-mcp-health-menu]')
    expect(menu?.textContent).toContain('MCP endpoint')
    expect(menu?.textContent).toContain('Compact profile for external agents')
    expect(menu?.textContent).not.toContain('Profiles')
    expect(menu?.textContent).not.toContain('Repair')
    expect(menu?.textContent).not.toContain('Author')
    expect(menu?.textContent).not.toContain('Full')
    expect(menu?.querySelector('[aria-label="MCP tools"]')).toBeNull()
    expect(menu?.textContent).not.toContain('1 tool')
    expect(menu?.textContent).toContain('Health OK at')
    expect(menu?.textContent).not.toContain('Check health')
    expect(menu?.textContent).not.toContain('Test MCP')

    const testButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Check health')
    expect(testButton).toBeFalsy()

    const connectButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Connect a client'))
    expect(connectButton).toBeTruthy()

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const connectionValues = [...document.body.querySelectorAll('[data-mcp-health-menu] code')]
      .map((value) => value.textContent)
    expect(connectionValues).toContain('npx canary-lab setup --force')
    expect(connectionValues.some((value) => value?.endsWith('/mcp?profile=compact'))).toBe(true)
    expect(document.body.querySelector('[data-mcp-health-menu]')?.textContent)
      .toContain('Registers only the compact MCP profile')
  })

  describe('the Getting started pill', () => {
    const demoPill = (): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')]
        .find((b): b is HTMLButtonElement => b.textContent?.includes('Getting started') ?? false)

    const renderBar = async (props: Partial<ComponentProps<typeof GlobalStatusBar>>): Promise<void> => {
      await act(async () => {
        root.render(<GlobalStatusBar activeRunDetail={null} {...props} />)
      })
    }

    it('is absent when the workspace hides Getting Started', async () => {
      await renderBar({ gettingStarted: { available: false, unseen: false, onOpen: vi.fn() } })
      expect(demoPill()).toBeUndefined()
    })

    it('appears when Getting Started is enabled', async () => {
      await renderBar({ gettingStarted: { available: true, unseen: false, onOpen: vi.fn() } })
      expect(demoPill()).toBeDefined()
    })

    it('carries an attention dot until the chooser has been opened', async () => {
      await renderBar({ gettingStarted: { available: true, unseen: true, onOpen: vi.fn() } })
      expect(demoPill()?.querySelector('span[aria-hidden="true"].absolute')).not.toBeNull()
    })

    it('drops the dot once the chooser has been opened', async () => {
      await renderBar({ gettingStarted: { available: true, unseen: false, onOpen: vi.fn() } })
      expect(demoPill()?.querySelector('span[aria-hidden="true"].absolute')).toBeNull()
    })

    it('opens the guide — the permanent way back after it is closed', async () => {
      const onOpenDemo = vi.fn()
      await renderBar({ gettingStarted: { available: true, unseen: false, onOpen: onOpenDemo } })
      await act(async () => {
        demoPill()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onOpenDemo).toHaveBeenCalledOnce()
    })
  })
})

// Test-review entry now lives in Notifications; the route still owns the dialog.
describe('GlobalStatusBar notifications and test review', () => {
  const dirty = { name: 'checkout', description: '', repos: [], envs: [], dirty: { status: 'dirty', specs: [{ file: 'e2e/a.spec.ts', affectedTests: ['a'], strength: { verdict: 'weaker', baseline: 'head', tests: [] } }] } }

  it('retains a linked completed suite when switching to committed tests', async () => {
    mockRuns.value = [{ runId: 'r1', feature: 'checkout', status: 'passed', pendingSpecEdits: 0 }]
    for (const baseline of ['run', undefined] as const) {
      await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ features: [], open: true, runId: 'r1', feature: 'checkout', focus: { baseline } }} />))
      expect(document.querySelector('[data-testid="dirty-review-suite-checkout"]')).not.toBeNull()
    }
  })

  it('places Notifications in the right cluster and removes the separate changed-tests pill', async () => {
    mockRuns.value = [{ runId: 'r1', feature: 'checkout', status: 'healing', startedAt: '', pendingSpecEdits: 1 }]
    await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ features: [dirty as never] }} notificationControl={<button>Notifications</button>} />))
    const inbox = container.querySelector('[data-testid="status-bar-notifications"]')!
    expect(inbox.textContent).toBe('Notifications')
    expect(inbox.parentElement?.className).toContain('ml-auto')
    expect([...container.querySelectorAll('button')].some((button) => /Tests (changed|weakened)/.test(button.textContent ?? ''))).toBe(false)
    expect(inbox.closest('[aria-hidden]')).toBeNull()
  })

  it('renders the review from its routed open-state and reports closing to the host', async () => {
    const onOpenChange = vi.fn()
    await act(async () => root.render(<GlobalStatusBar activeRunDetail={null} review={{ features: [dirty as never], open: true, onOpenChange }} />))
    expect(document.querySelector('[role="dialog"][aria-label="Changed test files"]')).not.toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"][aria-label="Changed test files"] button[aria-label="Close"]')!.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
