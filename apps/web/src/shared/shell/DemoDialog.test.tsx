// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GettingStartedSessionState,
  GettingStartedTarget,
  OnboardingWorkflow,
  OnboardingWorkflowAction,
  OnboardingWorkflowId,
} from '@/shared/api/client'
import { DemoDialog } from './DemoDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKFLOWS: OnboardingWorkflow[] = [
  ['run', 'start', 1, 'Repair a broken suite', '/canary-lab-run'],
  ['flight', 'start', 2, 'Take a repo through Full Flight', '/canary-lab'],
  ['coverage', 'more', 1, 'Measure Coverage', '/canary-lab-coverage'],
  ['author', 'more', 2, 'Author Tests', '/canary-lab-author'],
  ['portify', 'more', 3, 'Enable Parallel Runs', '/canary-lab-portify'],
  ['verify', 'more', 4, 'Verify a Running App', '/canary-lab-verify'],
  ['export', 'more', 5, 'Export an Evaluation', '/canary-lab-export'],
].map(([id, group, order, title, skill]) => ({
  id: id as OnboardingWorkflowId,
  group: group as 'start' | 'more',
  order: order as number,
  title: title as string,
  outcome: `${title} outcome`,
  steps: ['One', 'Two', 'Three'],
  skill: skill as string,
  externalPrompt: `${skill} exact-${id}`,
  internalAction: id === 'flight'
    ? { kind: 'flight', repoPath: '/w/flight-app', description: 'lending' }
    : { kind: id, feature: id === 'run' || id === 'export' ? 'storefront-journey' : 'workflow-workbench' } as OnboardingWorkflowAction,
  unavailableReason: null,
}))

const READY: GettingStartedSessionState = { active: null, completed: {} }

let container: HTMLDivElement
let root: Root
const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

interface Overrides {
  open?: boolean
  workflows?: OnboardingWorkflow[]
  session?: GettingStartedSessionState
  actionBlockers?: Partial<Record<OnboardingWorkflowId, string>>
  onInternalAction?: (action: OnboardingWorkflowAction) => void | Promise<void>
  onOpenTarget?: (target: GettingStartedTarget) => void
  showDemo?: boolean | null
  onShowDemoChange?: (next: boolean) => void
}

function render(over: Overrides = {}): void {
  act(() => {
    root.render(
      <DemoDialog
        open={over.open ?? true}
        onClose={() => {}}
        workflows={over.workflows ?? WORKFLOWS}
        session={over.session ?? READY}
        actionBlockers={over.actionBlockers}
        onInternalAction={over.onInternalAction ?? (() => {})}
        onOpenTarget={over.onOpenTarget ?? (() => {})}
        showDemo={over.showDemo === undefined ? true : over.showDemo}
        onShowDemoChange={over.onShowDemoChange ?? (() => {})}
      />,
    )
  })
}

const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`)

function click(element: Element | null): void {
  if (!element) throw new Error('nothing to click')
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('DemoDialog', () => {
  it('renders nothing while closed', () => {
    render({ open: false })
    expect(q('demo-dialog')).toBeNull()
  })

  it('lists every workflow in the rail and opens on the first starter', () => {
    render()
    for (const id of ['run', 'flight', 'coverage', 'author', 'portify', 'verify', 'export']) {
      expect(q(`getting-started-workflow-${id}`)).not.toBeNull()
    }
    expect(q('getting-started-detail')?.textContent).toContain('Repair a broken suite')
    // One workflow's actions exist at a time — that is what the rail buys.
    expect(q('getting-started-action-run')).not.toBeNull()
    expect(q('getting-started-action-coverage')).toBeNull()
    expect(q('demo-dialog')?.querySelector('[role="tablist"]')).toBeNull()
  })

  it('shows the exact slash command and says where to paste it', async () => {
    render()
    expect(q('getting-started-command-run')?.textContent).toContain('/canary-lab-run exact-run')
    expect(q('getting-started-detail')?.textContent).toContain('Paste it in Claude or Codex')
    click(q('getting-started-copy-run'))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('/canary-lab-run exact-run')
  })

  it('keeps one accent action per pane — running here is primary, copying is not', () => {
    const onInternalAction = vi.fn()
    render({ onInternalAction })
    click(q('getting-started-action-run'))
    expect(onInternalAction).toHaveBeenCalledWith({ kind: 'run', feature: 'storefront-journey' })
    expect(q('getting-started-action-run')?.className).toContain('cl-button-primary')
    expect(q('getting-started-copy-run')?.className).not.toContain('cl-button-primary')
  })

  it('swaps the pane to any secondary workflow picked in the rail', () => {
    render()
    click(q('getting-started-workflow-coverage'))
    expect(q('getting-started-action-coverage')?.textContent).toContain('Measure coverage')
    expect(q('getting-started-detail')?.textContent).toContain('One')
    expect(q('getting-started-command-coverage')?.textContent).toContain('/canary-lab-coverage exact-coverage')
    expect(q('getting-started-action-run')).toBeNull()
    click(q('getting-started-workflow-author'))
    expect(q('getting-started-action-coverage')).toBeNull()
    expect(q('getting-started-action-author')).not.toBeNull()
  })

  it('reopens an internally running demo at its real owner and blocks every competing start', () => {
    const onOpenTarget = vi.fn()
    const session: GettingStartedSessionState = {
      active: {
        sessionId: 'gs-1', workflow: 'run', owner: 'internal',
        target: { kind: 'run', id: 'run-1' }, startedAt: 'a', updatedAt: 'a',
      },
      completed: {},
    }
    render({ session, onOpenTarget })
    // The running workflow owns the pane on open.
    expect(q('getting-started-action-run')?.textContent).toContain('Open run')
    expect((q('getting-started-copy-run') as HTMLButtonElement).disabled).toBe(true)
    click(q('getting-started-action-run'))
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'run', id: 'run-1' })
    click(q('getting-started-workflow-flight'))
    expect((q('getting-started-action-flight') as HTMLButtonElement).disabled).toBe(true)
    click(q('getting-started-workflow-coverage'))
    expect((q('getting-started-action-coverage') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows external ownership in place without pretending progress lives in the dialog', () => {
    render({
      session: {
        active: {
          sessionId: 'gs-2', workflow: 'flight', owner: 'external',
          target: { kind: 'flight', id: 'fl-1' }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      },
    })
    expect(q('getting-started-action-flight')?.textContent).toContain('Running in your agent')
    expect(q('getting-started-detail')?.textContent).toContain('Follow progress in your Claude or Codex session')
  })

  it('keeps completed evidence available as a link to the last owner page', () => {
    const onOpenTarget = vi.fn()
    render({
      session: {
        active: null,
        completed: {
          flight: {
            workflow: 'flight', owner: 'internal', target: { kind: 'flight', id: 'fl-done' },
            status: 'completed', startedAt: 'a', endedAt: 'b',
          },
        },
      },
      onOpenTarget,
    })
    click(q('getting-started-workflow-flight'))
    expect(q('getting-started-detail')?.textContent).toContain('Last result: completed')
    click(q('getting-started-action-flight'))
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'flight', id: 'fl-done' })
  })

  it('gives a state line a fixed height so its wording never resizes the card', () => {
    render({
      session: {
        active: {
          sessionId: 'gs-3', workflow: 'run', owner: 'internal',
          target: { kind: 'run', id: 'run-9' }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      },
    })
    expect(q('getting-started-detail')?.querySelector('[role="status"]')?.className).toContain('h-9')
    // Nothing to report reserves nothing — an empty row read as dead space
    // inside the card.
    click(q('getting-started-workflow-flight'))
    expect(q('getting-started-detail')?.querySelector('[role="status"]')?.textContent).toContain('Run and Heal is running')
  })

  it('does not use a Recommended label', () => {
    render()
    expect(q('demo-dialog')?.textContent).not.toContain('Recommended')
  })

  it('reports the status-bar preference', () => {
    const onShowDemoChange = vi.fn()
    render({ showDemo: false, onShowDemoChange })
    expect((q('demo-show-toggle') as HTMLInputElement).checked).toBe(false)
    click(q('demo-show-toggle'))
    expect(onShowDemoChange).toHaveBeenCalledWith(true)
  })
})
