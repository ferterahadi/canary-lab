// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { WizardDraftProvider, isActiveWizardTask, isVisibleWizardTask, useWizardDrafts } from './WizardDraftContext'
import { Probe, draft, workspaceSocket } from './__fixtures__/wizard-draft-context-fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    cancelDraftGeneration: vi.fn(),
    deleteDraft: vi.fn(),
  }
})

export class FakeWebSocket {
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
  vi.mocked(api.cancelDraftGeneration).mockReset()
  vi.mocked(api.deleteDraft).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

// The provider is the live draft LIST. Every draft is authored by an external
// MCP client, so the surface is read + stop + delete: no start, no accept.
describe('WizardDraftProvider', () => {
  it('loads visible drafts on startup, newest first, hiding accepted ones', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'planning-a', status: 'planning', createdAt: '2026-01-02T00:00:00.000Z' }),
      draft({ draftId: 'ready-b', status: 'plan-ready', createdAt: '2026-01-01T00:00:00.000Z' }),
      draft({ draftId: 'accepted-c', status: 'accepted', createdAt: '2026-01-03T00:00:00.000Z' }),
    ])

    const captured = renderProbe()
    await settle()

    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['planning-a', 'ready-b'])
  })

  it('discovers drafts created outside this page session', async () => {
    const captured = renderProbe()
    await settle()

    act(() => {
      workspaceSocket().fire({ type: 'draft-created', draft: draft({ draftId: 'external-a', status: 'generating' }) })
    })

    expect(captured.value?.drafts.map((item) => item.draftId)).toEqual(['external-a'])
  })

  it('updates a draft in place from workspace events instead of polling', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'planning' })])
    const captured = renderProbe()
    await settle()

    act(() => {
      workspaceSocket().fire({ type: 'draft-updated', draft: draft({ draftId: 'd-1', status: 'spec-ready' }) })
    })

    expect(captured.value?.drafts[0]?.status).toBe('spec-ready')
    expect(api.getDraft).not.toHaveBeenCalled()
  })

  it('drops a draft that an update marks accepted, and one a delete event removes', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([
      draft({ draftId: 'd-1', status: 'planning' }),
      draft({ draftId: 'd-2', status: 'planning' }),
    ])
    const captured = renderProbe()
    await settle()

    act(() => {
      workspaceSocket().fire({ type: 'draft-updated', draft: draft({ draftId: 'd-1', status: 'accepted' }) })
    })
    expect(captured.value?.drafts.map((d) => d.draftId)).toEqual(['d-2'])

    act(() => {
      workspaceSocket().fire({ type: 'draft-deleted', draftId: 'd-2' })
    })
    expect(captured.value?.drafts).toEqual([])
  })

  it('ignores a startup list that resolves after unmount, and survives a list failure', async () => {
    let resolveList: (value: never[]) => void = () => {}
    vi.mocked(api.listDrafts).mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    renderProbe()
    act(() => { root.unmount() })
    await act(async () => { resolveList([]) })

    // A failing list leaves an empty board rather than throwing.
    root = createRoot(container)
    vi.mocked(api.listDrafts).mockRejectedValue(new Error('offline'))
    const captured = renderProbe()
    await settle()
    expect(captured.value?.drafts).toEqual([])
  })

  it('refreshDraft re-reads one record, and returns null when the read fails', async () => {
    const captured = renderProbe()
    await settle()

    vi.mocked(api.getDraft).mockResolvedValue(draft({ draftId: 'd-1', status: 'generating' }))
    let refreshed: unknown
    await act(async () => { refreshed = await captured.value?.refreshDraft('d-1') })
    expect((refreshed as { draftId: string }).draftId).toBe('d-1')
    expect(captured.value?.drafts.map((d) => d.draftId)).toEqual(['d-1'])

    vi.mocked(api.getDraft).mockRejectedValue(new Error('gone'))
    let missing: unknown = 'unset'
    await act(async () => { missing = await captured.value?.refreshDraft('d-1') })
    expect(missing).toBeNull()
    // The failed read must not evict the record we already have.
    expect(captured.value?.drafts.map((d) => d.draftId)).toEqual(['d-1'])
  })

  it('refreshDraft forgets a record the server now reports as accepted', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'generating' })])
    const captured = renderProbe()
    await settle()

    vi.mocked(api.getDraft).mockResolvedValue(draft({ draftId: 'd-1', status: 'accepted' }))
    await act(async () => { await captured.value?.refreshDraft('d-1') })
    expect(captured.value?.drafts).toEqual([])
  })

  it('deleteTask stops an in-flight session first, then deletes', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'generating' })])
    vi.mocked(api.cancelDraftGeneration).mockResolvedValue({ draftId: 'd-1', status: 'cancelled' })
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined)
    const captured = renderProbe()
    await settle()

    await act(async () => { await captured.value?.deleteTask('d-1') })

    expect(api.cancelDraftGeneration).toHaveBeenCalledWith('d-1')
    expect(api.deleteDraft).toHaveBeenCalledWith('d-1')
    expect(captured.value?.drafts).toEqual([])
  })

  it('deleteTask skips the stop call for a settled draft', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'spec-ready' })])
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined)
    const captured = renderProbe()
    await settle()

    await act(async () => { await captured.value?.deleteTask('d-1') })

    expect(api.cancelDraftGeneration).not.toHaveBeenCalled()
    expect(captured.value?.drafts).toEqual([])
  })

  it('deleteTask forgets the record even when both server calls fail', async () => {
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'generating' })])
    vi.mocked(api.cancelDraftGeneration).mockRejectedValue(new Error('already stopped'))
    vi.mocked(api.deleteDraft).mockRejectedValue(new Error('already gone'))
    const captured = renderProbe()
    await settle()

    await act(async () => { await captured.value?.deleteTask('d-1') })

    expect(captured.value?.drafts).toEqual([])
  })

  it('deleteTask on an id it never saw skips the stop call and still deletes', async () => {
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined)
    const captured = renderProbe()
    await settle()

    await act(async () => { await captured.value?.deleteTask('never-seen') })
    expect(api.cancelDraftGeneration).not.toHaveBeenCalled()
    expect(api.deleteDraft).toHaveBeenCalledWith('never-seen')
  })

  it('keeps working when the workspace socket cannot be opened', async () => {
    const Boom = function Boom() { throw new Error('no socket') } as unknown as typeof WebSocket
    vi.mocked(api.listDrafts).mockResolvedValue([draft({ draftId: 'd-1', status: 'planning' })])
    const captured: { value: ReturnType<typeof useWizardDrafts> | null } = { value: null }
    act(() => {
      root.render(
        <WizardDraftProvider WebSocketImpl={Boom} wsBase="ws://test">
          <Probe captured={captured} />
        </WizardDraftProvider>,
      )
    })
    await settle()
    expect(captured.value?.drafts.map((d) => d.draftId)).toEqual(['d-1'])
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

describe('draft status predicates', () => {
  it('treats planning and generating as active — the two interruptible statuses', () => {
    expect(isActiveWizardTask('planning')).toBe(true)
    expect(isActiveWizardTask('generating')).toBe(true)
    expect(isActiveWizardTask('spec-ready')).toBe(false)
    expect(isActiveWizardTask('accepted')).toBe(false)
  })

  it('hides only accepted drafts — a cancelled or errored one still needs clearing', () => {
    expect(isVisibleWizardTask(draft({ status: 'accepted' }))).toBe(false)
    expect(isVisibleWizardTask(draft({ status: 'cancelled' }))).toBe(true)
    expect(isVisibleWizardTask(draft({ status: 'error' }))).toBe(true)
  })
})

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

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
