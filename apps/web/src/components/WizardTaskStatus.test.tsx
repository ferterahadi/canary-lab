// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftRecord } from '../api/types'
import { WizardTaskStatus } from './WizardTaskStatus'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const context = {
  drafts: [] as DraftRecord[],
  latestTask: null as DraftRecord | null,
  selectedDraft: null as DraftRecord | null,
  wizardOpen: false,
  openTask: vi.fn(),
  cancelGeneration: vi.fn(),
  deleteTask: vi.fn(),
}

vi.mock('../state/WizardDraftContext', () => ({
  useWizardDrafts: () => context,
  isActiveWizardTask: (status: DraftRecord['status']) => status === 'planning' || status === 'generating',
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  context.drafts = []
  context.latestTask = null
  context.selectedDraft = null
  context.wizardOpen = false
  context.openTask.mockReset()
  context.cancelGeneration.mockReset()
  context.deleteTask.mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('WizardTaskStatus', () => {
  it('renders nothing without wizard tasks', () => {
    act(() => {
      root.render(<WizardTaskStatus />)
    })
    expect(container.textContent).toBe('')
  })

  it('shows task count, opens the list, and selects a task into the full wizard', () => {
    context.drafts = [
      draft({ draftId: 'newer', status: 'generating', featureName: 'checkout-flow' }),
      draft({ draftId: 'older', status: 'plan-ready', featureName: 'profile-flow' }),
    ]
    context.latestTask = context.drafts[0]

    act(() => {
      root.render(<WizardTaskStatus />)
    })

    expect(container.textContent).toContain('Generating')
    expect(container.textContent).toContain('2')

    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Wizard tasks')
    expect(container.textContent).toContain('Running')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('checkout-flow')
    expect(container.textContent).toContain('profile-flow')

    const profileButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('profile-flow'))
    act(() => {
      profileButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(context.openTask).toHaveBeenCalledWith('older')
    expect(container.textContent).not.toContain('Wizard tasks')
  })

  it('stops only the selected running task and removes any task card', () => {
    context.drafts = [
      draft({ draftId: 'running', status: 'planning', featureName: 'running-flow' }),
      draft({ draftId: 'ready', status: 'plan-ready', featureName: 'ready-flow' }),
      draft({ draftId: 'failed', status: 'error', featureName: 'failed-flow', errorMessage: 'boom' }),
    ]
    context.latestTask = context.drafts[0]

    act(() => {
      root.render(<WizardTaskStatus />)
    })
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const stop = container.querySelector('button[aria-label="Stop wizard task running-flow"]')
    const removeRunning = container.querySelector('button[aria-label="Remove wizard task running-flow"]')
    const removeReady = container.querySelector('button[aria-label="Remove wizard task ready-flow"]')
    const removeFailed = container.querySelector('button[aria-label="Remove wizard task failed-flow"]')

    expect(stop).not.toBeNull()
    expect(removeRunning).toBeNull()
    expect(removeReady).not.toBeNull()
    expect(removeFailed).not.toBeNull()

    act(() => {
      stop?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      removeReady?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      removeFailed?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(context.cancelGeneration).toHaveBeenCalledWith('running')
    expect(context.deleteTask).not.toHaveBeenCalledWith('running')
    expect(context.deleteTask).toHaveBeenCalledWith('ready')
    expect(context.deleteTask).toHaveBeenCalledWith('failed')
  })

  it('filters tasks via the filter chips', () => {
    context.drafts = [
      draft({ draftId: 'r1', status: 'planning', featureName: 'running-a' }),
      draft({ draftId: 'r2', status: 'plan-ready', featureName: 'ready-a' }),
      draft({ draftId: 'r3', status: 'error', featureName: 'failed-a', errorMessage: 'x' }),
    ]
    context.latestTask = context.drafts[0]

    act(() => {
      root.render(<WizardTaskStatus />)
    })
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const failedChip = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('role') === 'tab' && b.textContent?.includes('Failed'))
    act(() => {
      failedChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('failed-a')
    expect(container.textContent).not.toContain('running-a')
    expect(container.textContent).not.toContain('ready-a')
  })

  it('routes external draft clicks to the external client instead of the internal wizard', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    context.drafts = [
      draft({
        draftId: 'external-1',
        status: 'generating',
        featureName: 'external-flow',
        source: 'external',
        externalStage: 'authoring-tests',
        externalClientKind: 'codex-cli',
        externalSessionId: 'sess-ext-1',
        externalConversationName: 'Add tests externally',
        externalSessionUrl: 'codex://session/sess-ext-1',
      }),
    ]
    context.latestTask = context.drafts[0]

    act(() => {
      root.render(<WizardTaskStatus />)
    })
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('external-flow')
    expect(container.textContent).toContain('authoring-tests')
    expect(container.textContent).toContain('codex-cli')

    const externalButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('external-flow'))
    act(() => {
      externalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(context.openTask).not.toHaveBeenCalled()
    expect(openSpy).toHaveBeenCalledWith('codex://session/sess-ext-1', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })

  it('shows a handoff panel when an external draft has no session URL', () => {
    context.drafts = [
      draft({
        draftId: 'external-2',
        status: 'spec-ready',
        featureName: 'handoff-flow',
        source: 'external',
        externalStage: 'ready',
        externalClientKind: 'claude-desktop',
        externalSessionId: 'sess-handoff',
        externalConversationName: 'Add handoff tests',
      }),
    ]
    context.latestTask = context.drafts[0]

    act(() => {
      root.render(<WizardTaskStatus />)
    })
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const handoffButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('handoff-flow'))
    act(() => {
      handoffButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(context.openTask).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Generated using external client')
    expect(container.textContent).toContain('sess-handoff')
    expect(container.textContent).toContain('Add handoff tests')
  })
})

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'draft-1',
    prdText: 'Checkout flow',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/app' }],
    featureName: 'checkout-flow',
    status: 'planning',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
