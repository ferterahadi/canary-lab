// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import { GlobalStatusBar } from './GlobalStatusBar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getMcpHealth: vi.fn(),
  }
})

const mockActiveRuns = vi.hoisted(() => ({ value: { runs: [] as unknown[], count: 0 } }))
const mockBootSessions = vi.hoisted(() => ({ value: { sessions: [] as unknown[], count: 0 } }))
const mockVerifyRuns = vi.hoisted(() => ({ value: { runs: [] as unknown[], count: 0 } }))

vi.mock('@/features/runs/state/RunsContext', () => ({
  useRuns: () => ({ connection: 'live', runs: [], abort: vi.fn() }),
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
  mockActiveRuns.value = { runs: [], count: 0 }
  mockBootSessions.value = { sessions: [], count: 0 }
  mockVerifyRuns.value = { runs: [], count: 0 }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getMcpHealth).mockImplementation(async (profile = 'repair') => {
    const tools = profile === 'author'
      ? ['list_features', 'write_feature_doc']
      : ['start_run', 'wait_for_heal_task']
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
          activity={new Map([['checkout', { kind: 'running', runId: 'r1' }]])}
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
          activity={new Map([
            ['pay', { kind: 'portifying', workflowId: 'wf1' }],
            ['cart', { kind: 'authoring', draftId: 'd1' }],
          ])}
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
          features={[
            { name: 'checkout', repos: [], envs: [], group: 'shop' },
            { name: 'cart', repos: [], envs: [], group: 'shop' },
            { name: 'admin', repos: [], envs: [] },
          ]}
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
  // which has no close of its own — this chip is the only way back.
  it('R83: offers a way back to the flight a drill-through came from', async () => {
    const onReturnToFlight = vi.fn()
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          returnFlight="fl_abc"
          returnFlightLabel="merchant-pass-fnb"
          onReturnToFlight={onReturnToFlight}
        />,
      )
    })
    const chip = container.querySelector('[data-testid="return-to-flight"]')
    expect(chip?.textContent).toContain('merchant-pass-fnb')
    await act(async () => { chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onReturnToFlight).toHaveBeenCalledWith('fl_abc')
  })

  it('R83: still offers the way back when the flight index no longer names it', async () => {
    await act(async () => {
      root.render(
        <GlobalStatusBar activeRunDetail={null} returnFlight="fl_abc" onReturnToFlight={vi.fn()} />,
      )
    })
    expect(container.querySelector('[data-testid="return-to-flight"]')?.textContent).toContain('Flight')
  })

  it('R83: no return chip when the user got here on their own', async () => {
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
    expect(api.getMcpHealth).toHaveBeenCalledWith('repair')

    const indicator = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'MCP connection details')
    expect(indicator).toBeTruthy()

    await act(async () => {
      indicator?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menu = document.body.querySelector('[data-mcp-health-menu]')
    expect(menu?.textContent).not.toContain('MCP repair profile')
    expect(menu?.textContent).toContain('MCP endpoint')
    expect(menu?.textContent).toContain('Ready for external repair agents')
    expect(menu?.textContent).toContain('Repair')
    expect(menu?.textContent).toContain('Profiles')
    expect(menu?.textContent).toContain('Author')
    expect(menu?.textContent).toContain('Full')
    expect(menu?.textContent).toContain('Tools')
    expect(menu?.textContent).toContain('2 tools')
    expect(menu?.textContent).toContain('start_run')
    expect(menu?.textContent).toContain('wait_for_heal_task')
    expect(menu?.textContent).toContain('Health OK at')
    expect(menu?.textContent).not.toContain('Check health')
    expect(menu?.textContent).not.toContain('Test MCP')

    const testButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Check health')
    expect(testButton).toBeFalsy()

    const authorButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Author'))
    expect(authorButton).toBeTruthy()

    await act(async () => {
      authorButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(api.getMcpHealth).toHaveBeenLastCalledWith('author')
    expect(document.body.querySelector('[data-mcp-health-menu]')?.textContent).toContain('write_feature_doc')
  })
})
