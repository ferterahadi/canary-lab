// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftRecord } from '../../../shared/api/types'

// Control the WizardDraftContext the dialog reads from. isActiveWizardTask is a
// pure status check — reproduce it rather than pulling the real module in.
const mocks = vi.hoisted(() => ({
  drafts: [] as DraftRecord[],
  refreshDraft: vi.fn(),
  deleteTask: vi.fn(),
}))

vi.mock('../state/WizardDraftContext', () => ({
  useWizardDrafts: () => ({ drafts: mocks.drafts, refreshDraft: mocks.refreshDraft, deleteTask: mocks.deleteTask }),
  isActiveWizardTask: (s: string) => s === 'planning' || s === 'generating',
}))

import { DraftDialog } from './DraftDialog'

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'draft-1',
    prdText: '',
    prdDocuments: [],
    repos: [],
    featureName: 'checkout',
    producer: 'external',
    externalStage: 'authoring-tests',
    externalClientKind: 'claude',
    externalConversationName: 'Add checkout tests',
    status: 'generating',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.drafts = []
  mocks.refreshDraft.mockReset().mockResolvedValue(null)
  mocks.deleteTask.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const byTestId = (id: string): HTMLElement | null => document.body.querySelector(`[data-testid="${id}"]`)

describe('DraftDialog', () => {
  it('renders the feature + the external agent session, and refreshes on open', async () => {
    mocks.drafts = [draft()]
    await act(async () => { root.render(<DraftDialog draftId="draft-1" onClose={vi.fn()} />) })
    expect(mocks.refreshDraft).toHaveBeenCalledWith('draft-1')
    expect(document.body.textContent).toContain('checkout')
    expect(document.body.textContent).toContain('Claude')
  })

  it('discards the draft (two-step) via deleteTask, then closes', async () => {
    mocks.drafts = [draft()]
    const onClose = vi.fn()
    await act(async () => { root.render(<DraftDialog draftId="draft-1" onClose={onClose} />) })

    // First click arms the confirm; nothing deleted yet.
    await act(async () => { byTestId('draft-discard')!.click() })
    expect(mocks.deleteTask).not.toHaveBeenCalled()

    await act(async () => { byTestId('draft-discard-confirm')!.click() })
    await flush()
    expect(mocks.deleteTask).toHaveBeenCalledWith('draft-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('auto-closes when the probe confirms the draft is gone', async () => {
    mocks.drafts = [] // not in the live list
    mocks.refreshDraft.mockResolvedValue(null) // server 404 / rejected — a real miss
    const onClose = vi.fn()
    await act(async () => { root.render(<DraftDialog draftId="missing" onClose={onClose} />) })
    await flush()
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open while the list is still loading (cold deep-link, not yet a miss)', async () => {
    mocks.drafts = [] // not listed yet
    // Probe hasn't resolved — the draft may still arrive; must NOT close.
    mocks.refreshDraft.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()
    await act(async () => { root.render(<DraftDialog draftId="dr_pending" onClose={onClose} />) })
    await flush()
    expect(onClose).not.toHaveBeenCalled()
  })
})
