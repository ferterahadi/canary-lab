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
  ['heal', 'more', 4, 'Run and Heal a Suite', '/canary-lab-run'],
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
    : { kind: id, feature: id === 'run' ? 'storefront-journey' : 'workflow-workbench' } as OnboardingWorkflowAction,
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

/** Tooltip hover. `mouseenter`/`mouseleave` do not bubble, so React's delegated
 *  listener sees them via the paired `mouseover`/`mouseout`. */
function hover(element: Element | null | undefined, over: boolean): void {
  if (!element) throw new Error('nothing to hover')
  act(() => {
    element.dispatchEvent(new MouseEvent(over ? 'mouseover' : 'mouseout', { bubbles: true }))
  })
}

const tooltip = (): Element | null => document.querySelector('[role="tooltip"]')

describe('DemoDialog', () => {
  it('renders nothing while closed', () => {
    render({ open: false })
    expect(q('demo-dialog')).toBeNull()
  })

  it('lists every workflow in the rail and opens on the first starter', () => {
    render()
    for (const id of ['run', 'flight', 'coverage', 'author', 'portify', 'heal', 'export']) {
      expect(q(`getting-started-workflow-${id}`)).not.toBeNull()
    }
    expect(q('getting-started-detail')?.textContent).toContain('Repair a broken suite')
    // One workflow's actions exist at a time — that is what the rail buys.
    expect(q('getting-started-action-run')).not.toBeNull()
    expect(q('getting-started-action-coverage')).toBeNull()
    expect(q('demo-dialog')?.querySelector('[role="tablist"]')).toBeNull()
  })

  it('gates the external command behind the same blocker as the action button', () => {
    // "Complete Run and Heal first." is a real precondition: the pasted command
    // would hit the same missing prerequisite in the agent, so the copy field
    // must not stay live while the button is blocked.
    render({ actionBlockers: { export: 'Complete Run and Heal first.' } })
    click(q('getting-started-workflow-export'))
    expect((q('getting-started-action-export') as HTMLButtonElement).disabled).toBe(true)
    expect((q('getting-started-copy-export') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the exact slash command and says where to paste it', async () => {
    render()
    expect(q('getting-started-command-run')?.textContent).toContain('/canary-lab-run exact-run')
    expect(q('getting-started-detail')?.textContent).toContain('Paste it in Claude or Codex')
    click(q('getting-started-copy-run'))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('/canary-lab-run exact-run')
  })

  it('gives the two run paths equal weight — neither control outranks the other', () => {
    const onInternalAction = vi.fn()
    render({ onInternalAction })
    click(q('getting-started-action-run'))
    expect(onInternalAction).toHaveBeenCalledWith({ kind: 'run', feature: 'storefront-journey' })
    // An accent fill on either side would read as "this is the real option, the
    // other is a footnote" — the whole point of the pair is that it isn't.
    expect(q('getting-started-action-run')?.className).not.toContain('cl-button-primary')
    expect(q('getting-started-copy-run')?.className).not.toContain('cl-button-primary')
    expect(q('getting-started-action-run')?.className).toContain('cl-button')
  })

  it('launches Run and Heal as a normal workbench run', () => {
    const onInternalAction = vi.fn()
    render({ onInternalAction })
    click(q('getting-started-workflow-heal'))
    expect(q('getting-started-command-heal')?.textContent).toContain('/canary-lab-run exact-heal')
    click(q('getting-started-action-heal'))
    expect(onInternalAction).toHaveBeenCalledWith({ kind: 'heal', feature: 'workflow-workbench' })
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

  it('shows one running rail dot without warning dots on the competing demos', () => {
    render({
      session: {
        active: {
          sessionId: 'gs-rail', workflow: 'run', owner: 'external',
          target: { kind: 'run', id: 'run-1' }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      },
    })

    const activeDot = q('getting-started-workflow-run')?.querySelector('.cl-status-dot')
    expect(activeDot?.className).toContain('bg-running')
    for (const id of ['flight', 'coverage', 'author', 'portify', 'heal', 'export']) {
      expect(q(`getting-started-workflow-${id}`)?.querySelector('.cl-status-dot')).toBeNull()
    }
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
    expect(q('getting-started-detail')?.textContent).toContain('Running in your Claude or Codex session')
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

  it('words a paused flight as paused, never as a completion', () => {
    // Pausing settles the claim, so a paused demo lands in `completed` — but
    // "Completed · Last result: paused." read as a contradiction on the demo's
    // most likely mid-tour state.
    render({
      session: {
        active: null,
        completed: {
          flight: {
            workflow: 'flight', owner: 'internal', target: { kind: 'flight', id: 'fl-paused' },
            status: 'paused', startedAt: 'a', endedAt: 'b',
          },
        },
      },
    })
    click(q('getting-started-workflow-flight'))
    expect(q('getting-started-detail')?.textContent).toContain('Paused · Continue from the Flight page.')
    expect(q('getting-started-detail')?.textContent).not.toContain('Completed')
  })

  it('states the run on the button as a dot, with the wording on hover', () => {
    render({
      session: {
        active: {
          sessionId: 'gs-3', workflow: 'run', owner: 'internal',
          target: { kind: 'run', id: 'run-9' }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      },
    })
    const button = q('getting-started-action-run')
    expect(button?.querySelector('.cl-status-dot')?.className).toContain('bg-running')

    // The wording is the hover, not the layout: nothing in the card renders it
    // until the pointer asks, and the card is the same size either way.
    expect(tooltip()).toBeNull()
    hover(button?.parentElement, true)
    expect(tooltip()?.textContent).toContain('Continue in the run page')
    hover(button?.parentElement, false)
    expect(tooltip()).toBeNull()

    // A screen reader gets no hover, so the same wording stays in a live region.
    expect(q('getting-started-detail')?.querySelector('[role="status"]')?.textContent)
      .toContain('Continue in the run page')
  })

  it('explains a disabled action, which swallows hover on the button itself', () => {
    render({
      session: {
        active: {
          sessionId: 'gs-4', workflow: 'run', owner: 'internal',
          target: { kind: 'run', id: 'run-9' }, startedAt: 'a', updatedAt: 'a',
        },
        completed: {},
      },
    })
    click(q('getting-started-workflow-flight'))
    const button = q('getting-started-action-flight') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.style.pointerEvents).toBe('none')
    hover(button.parentElement, true)
    expect(tooltip()?.textContent).toContain('Waiting for Repair a Broken Suite to finish')
  })

  it('shows no dot and no tooltip when there is nothing to report', () => {
    render()
    const button = q('getting-started-action-run')
    expect(button?.querySelector('.cl-status-dot')).toBeNull()
    hover(button?.parentElement, true)
    expect(tooltip()).toBeNull()
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
