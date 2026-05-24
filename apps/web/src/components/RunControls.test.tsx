// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../api/types'
import { RunDetailColumn } from './RunDetailColumn'
import { RunsColumn } from './RunsColumn'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../state/RunsContext', () => ({
  useRun: vi.fn(),
  useRuns: vi.fn(() => ({
    transients: {},
    errors: {},
    abort: vi.fn(),
    delete: vi.fn(),
    pauseHeal: vi.fn(),
    cancelHeal: vi.fn(),
    clearError: vi.fn(),
  })),
}))

vi.mock('../state/EvaluationExportContext', () => ({
  useEvaluationExports: vi.fn(() => ({
    startExport: vi.fn(),
  })),
}))

vi.mock('./AgentSessionView', () => ({
  AgentSessionView: () => <div>agent session</div>,
}))

vi.mock('./PaneTerminal', () => ({
  PaneTerminal: () => <div>terminal</div>,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('run launch controls', () => {
  it('opens envset choices from Run and starts the chosen envset', () => {
    const onStartRun = vi.fn()

    act(() => {
      root.render(
        <RunsColumn
          feature="alpha"
          envs={['local', 'beta']}
          runs={[]}
          selectedRunId={null}
          onSelectRun={() => {}}
          onStartRun={onStartRun}
          onStartVerification={async () => {}}
        />,
      )
    })

    const runButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Run')
    expect(runButton).toBeTruthy()

    act(() => {
      runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onStartRun).not.toHaveBeenCalled()
    const menu = document.body.querySelector('[role="menu"][data-run-launch-menu]')
    expect(menu?.textContent).toContain('local')
    expect(menu?.textContent).toContain('beta')

    const betaOption = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('beta'))
    expect(betaOption).toBeTruthy()

    act(() => {
      betaOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onStartRun).toHaveBeenCalledExactlyOnceWith('beta')
    expect(document.body.querySelector('[role="menu"][data-run-launch-menu]')).toBeNull()
  })
})

describe('run overview', () => {
  it('shows the envset recorded on the run manifest', async () => {
    const { useRun } = await import('../state/RunsContext')
    vi.mocked(useRun).mockReturnValue({
      detail: runDetail({ env: 'beta' }),
      indexed: undefined,
      transient: null,
      status: 'passed',
    })

    await act(async () => {
      root.render(<RunDetailColumn runId="run-1" />)
    })

    expect(container.textContent).toContain('Envset')
    expect(container.textContent).toContain('beta')
  })
})

function runDetail(overrides: Partial<RunDetail['manifest']> = {}): RunDetail {
  return {
    manifest: {
      runId: 'run-1',
      executionType: 'run',
      feature: 'alpha',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
      ...overrides,
    },
    summary: {
      complete: true,
      total: 0,
      passed: 0,
      failed: [],
    },
  }
}
