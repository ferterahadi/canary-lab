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
      projectRoot: '/Users/oddle/Documents/canary-lab-workspace',
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
})

function portifyButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Open port-ification')) as HTMLButtonElement | undefined
}

function runsButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Show all runs')) as HTMLButtonElement | undefined
}

function servicesButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Show booted services')) as HTMLButtonElement | undefined
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

  it('hides the Portify button when no port-ification is active', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = undefined
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    expect(portifyButton()).toBeUndefined()
  })

  it('shows the Portify button while active and opens that workflow on click', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = { workflowId: 'portify-1', feature: 'cns', status: 'verifying', startedAt: 't' }
    const onOpenPortify = vi.fn()
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} onOpenPortify={onOpenPortify} />) })
    const button = portifyButton()
    expect(button).toBeTruthy()
    expect(button?.textContent).toContain('Portify')
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenPortify).toHaveBeenCalledWith('portify-1')
  })

  it('labels the Portify button "ready" when the workflow awaits commit', async () => {
    mockActiveRuns.value = { runs: [], count: 0 }
    mockActivePortify.value = { workflowId: 'portify-1', feature: 'cns', status: 'ready-to-commit', startedAt: 't' }
    await act(async () => { root.render(<GlobalStatusBar activeRunDetail={null} />) })
    expect(portifyButton()?.textContent).toContain('ready')
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
    expect(menu?.textContent).toContain('canary-lab-workspace')
    expect(menu?.textContent).toContain('Repair')
    expect(menu?.textContent).toContain('Profiles')
    expect(menu?.textContent).toContain('Author')
    expect(menu?.textContent).toContain('Full')
    expect(menu?.textContent).toContain('/mcp')
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
