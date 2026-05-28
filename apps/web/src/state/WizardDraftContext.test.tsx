// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { DraftRecord } from '../api/types'
import { WizardDraftProvider, useWizardDrafts } from './WizardDraftContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    cancelDraftGeneration: vi.fn(),
    acceptPlan: vi.fn(),
    acceptSpec: vi.fn(),
    rejectDraft: vi.fn(),
    deleteDraft: vi.fn(),
  }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  closeCalls = 0

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closeCalls += 1
  }

  fire(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  FakeWebSocket.instances = []
  vi.useRealTimers()
  vi.mocked(api.listDrafts).mockReset().mockResolvedValue([])
  vi.mocked(api.getDraft).mockReset()
  vi.mocked(api.createDraft).mockReset()
  vi.mocked(api.cancelDraftGeneration).mockReset()
  vi.mocked(api.acceptPlan).mockReset()
  vi.mocked(api.acceptSpec).mockReset()
  vi.mocked(api.rejectDraft).mockReset()
  vi.mocked(api.deleteDraft).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('WizardDraftProvider', () => {
  it('loads visible drafts on startup and selects a requested task', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'planning-a', status: 'planning', createdAt: '2026-01-02T00:00:00.000Z' }),
      draft({ draftId: 'ready-b', status: 'plan-ready', createdAt: '2026-01-01T00:00:00.000Z' }),
      draft({ draftId: 'accepted-c', status: 'accepted', createdAt: '2026-01-03T00:00:00.000Z' }),
    ])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['planning-a', 'ready-b'])
    expect(captured.value?.latestTask?.draftId).toBe('planning-a')

    act(() => {
      captured.value?.openTask('ready-b')
    })

    expect(captured.value?.wizardOpen).toBe(true)
    expect(captured.value?.selectedDraft?.draftId).toBe('ready-b')
  })

  it('discovers visible drafts created outside the current page session', async () => {
    const external = draft({
      draftId: 'external-a',
      status: 'planning',
      source: 'external',
      externalStage: 'scaffolding',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    vi.mocked(api.listDrafts).mockResolvedValueOnce([])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured.value?.drafts).toEqual([])

    act(() => {
      workspaceSocket().fire({ type: 'draft-created', draft: external })
    })

    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['external-a'])
    expect(captured.value?.latestTask?.source).toBe('external')
  })

  it('reconciles hidden draft records after the page is already open', async () => {
    vi.mocked(api.listDrafts).mockResolvedValueOnce([draft({ draftId: 'ready-a', status: 'spec-ready' })])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      captured.value?.openTask('ready-a')
    })
    expect(captured.value?.selectedDraft?.draftId).toBe('ready-a')

    act(() => {
      workspaceSocket().fire({ type: 'draft-updated', draft: draft({ draftId: 'ready-a', status: 'accepted' }) })
    })

    expect(captured.value?.drafts).toEqual([])
    expect(captured.value?.selectedDraft).toBeNull()
  })

  it('reconciles startup results against a preselected draft id', async () => {
    let resolveDrafts: (drafts: DraftRecord[]) => void = () => {}
    vi.mocked(api.listDrafts).mockReturnValueOnce(
      new Promise<DraftRecord[]>((resolve) => { resolveDrafts = resolve }),
    )
    const captured = renderProbe()

    act(() => {
      captured.value?.openTask('keep-selected')
    })
    await act(async () => {
      resolveDrafts([draft({ draftId: 'keep-selected', status: 'plan-ready' })])
      await Promise.resolve()
    })
    expect(captured.value?.selectedDraft?.draftId).toBe('keep-selected')

    act(() => {
      root.unmount()
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    })
    vi.mocked(api.listDrafts).mockReturnValueOnce(
      new Promise<DraftRecord[]>((resolve) => { resolveDrafts = resolve }),
    )
    const missing = renderProbe()
    act(() => {
      missing.value?.openTask('missing-selected')
    })
    await act(async () => {
      resolveDrafts([])
      await Promise.resolve()
    })

    expect(missing.value?.selectedDraft).toBeNull()
  })

  it('removes draft records deleted by workspace events', async () => {
    vi.mocked(api.listDrafts).mockResolvedValueOnce([draft({ draftId: 'remove-me', status: 'plan-ready' })])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      captured.value?.openTask('remove-me')
    })
    expect(captured.value?.wizardOpen).toBe(true)

    act(() => {
      workspaceSocket().fire({ type: 'draft-deleted', draftId: 'remove-me' })
      workspaceSocket().fire({ type: 'features-changed' })
    })

    expect(captured.value?.drafts).toEqual([])
    expect(captured.value?.selectedDraft).toBeNull()
  })

  it('ignores startup results after the provider unmounts', async () => {
    let resolveDrafts!: (drafts: DraftRecord[]) => void
    vi.mocked(api.listDrafts).mockReturnValue(new Promise((resolve) => {
      resolveDrafts = resolve
    }))
    const captured = renderProbe()

    act(() => {
      root.unmount()
    })
    await act(async () => {
      resolveDrafts([draft({ draftId: 'late', status: 'planning' })])
      await Promise.resolve()
    })

    expect(captured.value?.drafts).toEqual([])
    root = createRoot(container)
  })

  it('clears a missing selected task when that id is deleted', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'keep', status: 'plan-ready' }),
    ])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      captured.value?.openTask('missing')
    })
    expect(captured.value?.selectedDraft).toBeNull()

    await act(async () => {
      await captured.value?.deleteTask('missing')
    })

    expect(captured.value?.selectedDraft).toBeNull()
  })

  it('updates active drafts from workspace events instead of periodic refresh', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'a', status: 'planning' }),
      draft({ draftId: 'b', status: 'generating' }),
      draft({ draftId: 'c', status: 'spec-ready' }),
    ])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      workspaceSocket().fire({ type: 'draft-updated', draft: draft({ draftId: 'a', status: 'plan-ready' }) })
      workspaceSocket().fire({ type: 'draft-updated', draft: draft({ draftId: 'b', status: 'spec-ready' }) })
    })

    expect(api.getDraft).not.toHaveBeenCalled()
    expect(captured.value?.drafts.find((item) => item.draftId === 'a')?.status).toBe('plan-ready')
    expect(captured.value?.drafts.find((item) => item.draftId === 'b')?.status).toBe('spec-ready')
  })

  it('starts new drafts, closes the modal without cancellation, and cancels explicitly', async () => {
    const captured = renderProbe()
    vi.mocked(api.createDraft).mockResolvedValue({ draftId: 'new-draft', status: 'planning' })
    vi.mocked(api.getDraft).mockResolvedValue(draft({ draftId: 'new-draft', status: 'planning' }))
    vi.mocked(api.cancelDraftGeneration).mockResolvedValue({ draftId: 'new-draft', status: 'cancelled' })

    await act(async () => {
      await captured.value?.startDraft({ prdText: 'checkout', repos: [{ name: 'app', localPath: '/app' }], featureName: 'checkout-flow' })
    })

    expect(captured.value?.wizardOpen).toBe(true)
    expect(captured.value?.selectedDraft?.draftId).toBe('new-draft')

    act(() => {
      captured.value?.closeWizard()
    })
    expect(captured.value?.wizardOpen).toBe(false)
    expect(api.cancelDraftGeneration).not.toHaveBeenCalled()
    expect(api.rejectDraft).not.toHaveBeenCalled()
    expect(api.deleteDraft).not.toHaveBeenCalled()

    await act(async () => {
      await captured.value?.cancelGeneration('new-draft')
    })
    expect(api.cancelDraftGeneration).toHaveBeenCalledWith('new-draft')
  })

  it('starts completed drafts without marking an active agent stage', async () => {
    const captured = renderProbe()
    vi.mocked(api.createDraft).mockResolvedValue({ draftId: 'ready-now', status: 'spec-ready' })
    vi.mocked(api.getDraft).mockResolvedValue(draft({ draftId: 'ready-now', status: 'spec-ready' }))

    const created = await act(async () => captured.value!.startDraft({
      prdText: 'checkout',
      prdDocuments: [{ name: 'prd.md', text: 'PRD' }],
      repos: [{ name: 'app', localPath: '/app' }],
    }))

    expect(created.activeAgentStage).toBeUndefined()
    expect(created.prdDocuments).toEqual([{ name: 'prd.md', text: 'PRD' }])
  })

  it('opens a fresh wizard and ignores startup list failures', async () => {
    vi.mocked(api.listDrafts).mockRejectedValue(new Error('offline'))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(captured.value?.drafts).toEqual([])
    act(() => {
      captured.value?.startNewWizard()
    })

    expect(captured.value?.wizardOpen).toBe(true)
    expect(captured.value?.selectedDraft).toBeNull()
  })

  it('opens the latest task by default and stays closed when no task exists', async () => {
    const empty = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      empty.value?.openTask()
    })
    expect(empty.value?.wizardOpen).toBe(false)

    act(() => {
      root.unmount()
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    })
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'older', status: 'plan-ready', createdAt: '2026-01-01T00:00:00.000Z' }),
      draft({ draftId: 'newer', status: 'spec-ready', createdAt: '2026-01-02T00:00:00.000Z' }),
    ])
    const withDrafts = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      withDrafts.value?.openTask()
    })
    expect(withDrafts.value?.wizardOpen).toBe(true)
    expect(withDrafts.value?.selectedDraft?.draftId).toBe('newer')
  })

  it('returns null when refresh fails and preserves the current draft', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'draft-a', status: 'planning' }),
    ])
    vi.mocked(api.getDraft).mockRejectedValue(new Error('missing'))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    let refreshed: DraftRecord | null | undefined
    await act(async () => {
      refreshed = await captured.value?.refreshDraft('draft-a')
    })

    expect(refreshed).toBeNull()
    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['draft-a'])
  })

  it('accepts plan and spec before refreshing the task', async () => {
    vi.mocked(api.getDraft)
      .mockResolvedValueOnce(draft({ draftId: 'draft-a', status: 'plan-ready' }))
      .mockResolvedValueOnce(draft({ draftId: 'draft-a', status: 'spec-ready' }))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.value?.acceptPlan('draft-a', [{ step: 'Add test', actions: ['Create spec'], expectedOutcome: 'Spec is generated' }])
    })
    await act(async () => {
      await captured.value?.acceptSpec('draft-a', 'checkout-flow')
    })

    expect(api.acceptPlan).toHaveBeenCalledWith('draft-a', [{ step: 'Add test', actions: ['Create spec'], expectedOutcome: 'Spec is generated' }], undefined)
    expect(api.acceptSpec).toHaveBeenCalledWith('draft-a', 'checkout-flow')
    expect(captured.value?.drafts[0].status).toBe('spec-ready')
  })

  it('rejects and deletes only the targeted draft', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'keep', status: 'plan-ready' }),
      draft({ draftId: 'remove', status: 'error' }),
    ])
    vi.mocked(api.rejectDraft).mockResolvedValue(undefined)
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined)
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.value?.rejectAndDelete('remove')
    })

    expect(api.rejectDraft).toHaveBeenCalledWith('remove')
    expect(api.deleteDraft).toHaveBeenCalledWith('remove')
    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['keep'])
  })

  it('removes drafts even when delete APIs report they are already gone', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'remove', status: 'error' }),
    ])
    vi.mocked(api.rejectDraft).mockRejectedValue(new Error('already terminal'))
    vi.mocked(api.deleteDraft).mockRejectedValue(new Error('already deleted'))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      captured.value?.openTask('remove')
    })

    await act(async () => {
      await captured.value?.rejectAndDelete('remove')
    })

    expect(captured.value?.drafts).toEqual([])
    expect(captured.value?.selectedDraft).toBeNull()
    expect(captured.value?.wizardOpen).toBe(false)
  })

  it('deletes a task locally when the server delete fails', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'remove', status: 'spec-ready' }),
    ])
    vi.mocked(api.deleteDraft).mockRejectedValue(new Error('already deleted'))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.value?.deleteTask('remove')
    })

    expect(api.deleteDraft).toHaveBeenCalledWith('remove')
    expect(captured.value?.drafts).toEqual([])
  })

  it('cancels active generation before deleting an active task card', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'active', status: 'generating' }),
    ])
    vi.mocked(api.cancelDraftGeneration).mockRejectedValue(new Error('already stopped'))
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined)
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.value?.deleteTask('active')
    })

    expect(api.cancelDraftGeneration).toHaveBeenCalledWith('active')
    expect(api.deleteDraft).toHaveBeenCalledWith('active')
    expect(captured.value?.drafts).toEqual([])
  })

  it('throws when the hook is used outside the provider', () => {
    function OutsideProviderProbe() {
      useWizardDrafts()
      return null
    }

    expect(() => {
      act(() => {
        root.render(<OutsideProviderProbe />)
      })
    }).toThrow('useWizardDrafts must be used inside WizardDraftProvider')
  })
})

function renderProbe() {
  const captured: { value: ReturnType<typeof useWizardDrafts> | null } = { value: null }
  act(() => {
    root.render(
      <WizardDraftProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket} wsBase="ws://test">
        <Probe captured={captured} />
      </WizardDraftProvider>,
    )
  })
  return captured
}

function workspaceSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((item) => item.url === 'ws://test/ws/workspace')
  if (!socket) throw new Error('workspace socket not opened')
  return socket
}

function Probe({ captured }: { captured: { value: ReturnType<typeof useWizardDrafts> | null } }) {
  captured.value = useWizardDrafts()
  return null
}

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
