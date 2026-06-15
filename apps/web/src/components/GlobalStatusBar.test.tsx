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

vi.mock('../state/RunsContext', () => ({
  useRuns: () => ({ connection: 'live', runs: [], abort: vi.fn() }),
  useActiveRuns: () => mockActiveRuns.value,
  useActiveBootSessions: () => mockBootSessions.value,
  useRun: () => ({ detail: undefined, status: undefined, transient: null }),
  useRunDetails: () => ({}),
}))

vi.mock('../state/BenchmarkContext', () => ({
  useBenchmarks: () => ({ benchmarks: [], connection: 'live', startBenchmark: vi.fn(), abortBenchmark: vi.fn(), loadBenchmark: vi.fn() }),
}))

const mockActivePortify = { value: undefined as undefined | { workflowId: string; feature: string; status: string; startedAt: string } }
vi.mock('../state/PortifyContext', () => ({
  useActivePortify: () => mockActivePortify.value,
}))

vi.mock('./BenchmarkWindow', () => ({
  BenchmarkWindow: () => null,
}))

vi.mock('./WizardTaskStatus', () => ({
  WizardTaskStatus: () => null,
}))

vi.mock('./EvaluationExportTaskToast', () => ({
  EvaluationExportTaskStatus: () => null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mockActiveRuns.value = { runs: [], count: 0 }
  mockBootSessions.value = { sessions: [], count: 0 }
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
  mockActivePortify.value = undefined
  window.history.replaceState(null, '', '/')
})

function portifyLauncherButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label') === 'Open Portify feature picker') as HTMLButtonElement | undefined
}

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
  it('hides the Runs button when no runs are running, healing, or queued', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    expect(runsButton()).toBeUndefined()
  })

  it('shows the Runs button with an active count when runs are active', async () => {
    mockActiveRuns.value = { runs: [{}, {}], count: 2 }
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    const button = runsButton()
    expect(button).toBeTruthy()
    expect(button?.getAttribute('aria-label')).toBe('Show all runs (2 active)')
    expect(button?.textContent).toContain('Runs')
    expect(button?.textContent).toContain('2')
  })

  it('keeps the Portify launcher idle (🔌, no "ready") when nothing is active', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = undefined
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    const button = portifyLauncherButton()
    expect(button).toBeTruthy()
    expect(button?.textContent).toContain('🔌')
    expect(button?.textContent).not.toContain('ready')
    expect(button?.getAttribute('title')).toContain('make a feature')
  })

  it('surfaces the in-flight feature on the Portify launcher while active', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = { workflowId: 'portify-1', feature: 'cns', status: 'verifying', startedAt: 't' }
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    const button = portifyLauncherButton()
    expect(button).toBeTruthy()
    // The 🔌 gives way to a live dot; the feature name moves into the tooltip.
    expect(button?.textContent).not.toContain('🔌')
    expect(button?.getAttribute('title')).toContain('cns')
  })

  it('labels the Portify launcher "ready" when the workflow awaits save', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = { workflowId: 'portify-1', feature: 'cns', status: 'ready-to-save', startedAt: 't' }
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    expect(portifyLauncherButton()?.textContent).toContain('ready')
  })

  it('surfaces booted services in the Services pill, separate from the Runs button', async () => {
    // A boot-only run is active: it must show in Services, never the Runs count.
    mockBootSessions.value = { sessions: [{}], count: 1 }
    mockActiveRuns.value = { runs: [{ executionType: 'boot' }], count: 1 }
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })
    const svc = servicesButton()
    expect(svc).toBeTruthy()
    expect(svc?.getAttribute('aria-label')).toBe('Show booted services (1 up)')
    expect(svc?.textContent).toContain('Services')
    expect(svc?.textContent).toContain('1')
    expect(runsButton()).toBeUndefined()
  })

  it('always shows the Portify launcher pill (even with no active workflow)', async () => {
    mockActivePortify.value = undefined
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    const launcher = portifyLauncherButton()
    expect(launcher).toBeTruthy()
    expect(launcher?.textContent).toContain('Portify')
  })

  it('launcher opens a feature picker; picking a feature starts port-ification', async () => {
    const onStartPortify = vi.fn()
    const features = [
      { name: 'cns', repos: [], envs: [], portified: false },
      { name: 'oms', repos: [], envs: [], portified: true },
    ]
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} features={features} onStartPortify={onStartPortify} />)
    })
    await act(async () => portifyLauncherButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const picker = document.body.querySelector('[aria-label="Portify a feature"]')
    expect(picker).toBeTruthy()
    expect(picker?.textContent).toContain('cns')
    expect(picker?.textContent).toContain('oms')
    expect(picker?.textContent).toContain('portified') // the already-portified badge

    const cnsRow = [...document.body.querySelectorAll('button')]
      .find((b) => b.getAttribute('title') === 'Portify cns')
    expect(cnsRow).toBeTruthy()
    await act(async () => cnsRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStartPortify).toHaveBeenCalledWith('cns')
    // Picker closes after selection.
    expect(document.body.querySelector('[aria-label="Portify a feature"]')).toBeNull()
  })

  it('picker shows the in-flight feature with a live status and reopens it on click', async () => {
    mockActivePortify.value = { workflowId: 'portify-1', feature: 'cns', status: 'verifying', startedAt: 't' }
    const onStartPortify = vi.fn()
    const onOpenPortify = vi.fn()
    const features = [
      { name: 'cns', repos: [], envs: [], portified: false },
      { name: 'oms', repos: [], envs: [], portified: false },
    ]
    await act(async () => {
      root.render(
        <GlobalStatusBar
          activeRunDetail={null}
          features={features}
          onStartPortify={onStartPortify}
          onOpenPortify={onOpenPortify}
        />,
      )
    })
    await act(async () => portifyLauncherButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const picker = document.body.querySelector('[aria-label="Portify a feature"]')
    expect(picker?.textContent).toContain('verifying') // live phase on the active row

    // The active row reopens the workflow instead of starting a new one.
    const cnsRow = [...document.body.querySelectorAll('button')]
      .find((b) => b.getAttribute('title') === 'View port-ification of cns')
    expect(cnsRow).toBeTruthy()
    await act(async () => cnsRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenPortify).toHaveBeenCalledWith('portify-1')
    expect(onStartPortify).not.toHaveBeenCalled()
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
    expect(container.textContent).toContain('ready')
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
