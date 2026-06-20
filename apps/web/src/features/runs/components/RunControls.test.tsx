// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../../api/types'
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

vi.mock('../../evaluation-export/state/EvaluationExportContext', () => ({
  useEvaluationExports: vi.fn(() => ({
    startExport: vi.fn(),
  })),
}))

const gatePromo = vi.fn((_action: string, continueAction: () => void) => continueAction())
vi.mock('../../../state/McpPromoContext', () => ({
  useMcpPromo: () => ({ gatePromo }),
}))

vi.mock('../../agent-sessions/components/AgentSessionView', () => ({
  AgentSessionView: () => <div>agent session</div>,
}))

vi.mock('./PaneTerminal', () => ({
  PaneTerminal: () => <div>terminal</div>,
}))

vi.mock('../../../components/VerificationDialog', () => ({
  VerificationDialog: () => <div data-testid="verification-dialog">verification dialog</div>,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gatePromo.mockImplementation((_action: string, continueAction: () => void) => continueAction())
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
  it('gates a run through the MCP promo before starting (env-less feature)', () => {
    const onStartRun = vi.fn()
    gatePromo.mockImplementationOnce(() => {})

    act(() => {
      root.render(
        <RunsColumn
          feature="alpha"
          envs={[]}
          runs={[]}
          selectedRunId={null}
          onSelectRun={() => {}}
          onStartRun={onStartRun}
          onStartVerification={async () => {}}
        />,
      )
    })

    // Open the Run menu, then use the env-less "Run tests" action.
    const runButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Run')
    act(() => {
      runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const runTests = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((b) => b.textContent?.includes('Run tests'))
    expect(runTests).toBeTruthy()
    act(() => {
      runTests?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(gatePromo).toHaveBeenCalledWith('run-test', expect.any(Function))
    expect(onStartRun).not.toHaveBeenCalled()

    act(() => {
      const continueAction = gatePromo.mock.calls[0][1] as () => void
      continueAction()
    })

    expect(onStartRun).toHaveBeenCalledExactlyOnceWith(undefined, 'test')
  })

  it('opens the Verify config dialog from the Run menu Verify tab', () => {
    const onStartVerification = vi.fn(async () => {})

    act(() => {
      root.render(
        <RunsColumn
          feature="alpha"
          envs={['local']}
          runs={[]}
          selectedRunId={null}
          onSelectRun={() => {}}
          onStartRun={() => {}}
          onStartVerification={onStartVerification}
        />,
      )
    })

    const runButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Run')
    act(() => {
      runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Switch the toggle to Verify, then click its CTA.
    const verifyToggle = [...document.body.querySelectorAll('[role="menu"][data-run-launch-menu] button')]
      .find((b) => b.textContent?.trim() === 'Verify')
    expect(verifyToggle).toBeTruthy()
    act(() => {
      verifyToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const verifyCta = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((b) => b.textContent?.includes('Set up'))
    expect(verifyCta).toBeTruthy()
    act(() => {
      verifyCta?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The launch popover closes and the Verify dialog opens.
    expect(document.body.querySelector('[role="menu"][data-run-launch-menu]')).toBeNull()
    expect(document.body.querySelector('[data-testid="verification-dialog"]')).toBeTruthy()
  })

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

    expect(onStartRun).toHaveBeenCalledExactlyOnceWith('beta', 'test')
    expect(gatePromo).toHaveBeenCalledWith('run-test', expect.any(Function))
    expect(document.body.querySelector('[role="menu"][data-run-launch-menu]')).toBeNull()
  })

  it('starts a boot-only session when the Boot toggle is selected', () => {
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
    act(() => {
      runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Flip the mode toggle to Boot, then choose an envset.
    const bootToggle = [...document.body.querySelectorAll('[role="menu"][data-run-launch-menu] button')]
      .find((button) => button.textContent?.trim() === 'Boot')
    expect(bootToggle).toBeTruthy()
    act(() => {
      bootToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The popover now advertises the boot behaviour.
    const menu = document.body.querySelector('[role="menu"][data-run-launch-menu]')
    expect(menu?.getAttribute('data-mode')).toBe('boot')
    expect(menu?.textContent).toContain('no tests')

    const betaOption = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('beta'))
    act(() => {
      betaOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onStartRun).toHaveBeenCalledExactlyOnceWith('beta', 'boot')
  })
})

describe('run overview', () => {
  it('gates raw and localized evaluation exports through the MCP promo', async () => {
    const { useRun } = await import('../state/RunsContext')
    const { useEvaluationExports } = await import('../../evaluation-export/state/EvaluationExportContext')
    const startExport = vi.fn()
    vi.mocked(useEvaluationExports).mockReturnValue({ startExport } as ReturnType<typeof useEvaluationExports>)
    vi.mocked(useRun).mockReturnValue({
      detail: runDetail({ status: 'passed' }),
      indexed: undefined,
      transient: null,
      status: 'passed',
    })
    gatePromo.mockImplementation((_action, _continueAction) => {})

    await act(async () => {
      root.render(<RunDetailColumn runId="run-1" />)
    })

    await act(async () => {
      clickButton('Export Evaluation')
    })
    await act(async () => {
      clickButton('Raw output')
    })

    expect(gatePromo).toHaveBeenCalledWith('export-evaluation', expect.any(Function))
    expect(startExport).not.toHaveBeenCalled()

    await act(async () => {
      const continueAction = gatePromo.mock.calls.at(-1)?.[1] as () => void
      continueAction()
    })
    expect(startExport).toHaveBeenCalledWith('run-1', 'raw')

    await act(async () => {
      clickButton('Export Evaluation')
    })
    await act(async () => {
      clickButton('Localized output')
    })
    await act(async () => {
      const continueAction = gatePromo.mock.calls.at(-1)?.[1] as () => void
      continueAction()
    })
    expect(startExport).toHaveBeenLastCalledWith('run-1', 'localized')
  })

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

  it('shows the heal agent recorded on the run manifest', async () => {
    const { useRun } = await import('../state/RunsContext')
    vi.mocked(useRun).mockReturnValue({
      detail: runDetail({ healMode: 'auto', healAgent: 'codex' }),
      indexed: undefined,
      transient: null,
      status: 'passed',
    })

    await act(async () => {
      root.render(<RunDetailColumn runId="run-1" />)
    })

    expect(container.textContent).toContain('Heal agent')
    expect(container.textContent).toContain('Codex')
  })

  it('shows an external waiting panel instead of an empty terminal before claim', async () => {
    const { useRun } = await import('../state/RunsContext')
    vi.mocked(useRun).mockReturnValue({
      detail: runDetail({
        status: 'healing',
        endedAt: undefined,
        healMode: 'external',
        lifecycle: {
          phase: 'waiting-for-signal',
          headline: 'Waiting for heal signal',
          updatedAt: '2026-01-01T00:00:30.000Z',
          activeCycle: 1,
        },
      }),
      indexed: undefined,
      transient: null,
      status: 'healing',
    })

    await act(async () => {
      root.render(<RunDetailColumn runId="run-1" />)
    })

    const healTab = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Heal agent')
    expect(healTab).toBeTruthy()

    await act(async () => {
      healTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('AI Agent')
    expect(container.textContent).toContain('No external client has claimed this run yet')
    expect(container.textContent).not.toContain('terminal')
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

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll('button')]
    .find((item) => item.textContent?.includes(label))
  expect(button).toBeTruthy()
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
