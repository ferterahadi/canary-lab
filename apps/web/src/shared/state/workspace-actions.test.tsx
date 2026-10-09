// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceActionsProvider, useWorkspaceActions, type WorkspaceActions } from './workspace-actions'
import { mountRoot } from '@/test-helpers/mount-root'

let root: Root
let seen: WorkspaceActions[]

mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })
beforeEach(() => {
  seen = []
})

function Probe() {
  seen.push(useWorkspaceActions())
  return null
}

describe('useWorkspaceActions', () => {
  it('reads a frozen empty object with no provider, so every affordance stays hidden', async () => {
    await act(async () => root.render(<Probe />))
    const actions = seen.at(-1)!
    expect(actions).toEqual({})
    expect(Object.isFrozen(actions)).toBe(true)
  })

  it('hands each leaf the callbacks the provider was given', async () => {
    const callbacks = {
      openFlight: vi.fn(), openActivity: vi.fn(), startFlight: vi.fn(), openPreFlight: vi.fn(),
      navigateToRun: vi.fn(), openPortifyStage: vi.fn(), openReview: vi.fn(),
    }
    await act(async () => root.render(<WorkspaceActionsProvider {...callbacks}><Probe /></WorkspaceActionsProvider>))
    expect(seen.at(-1)).toEqual(callbacks)
  })

  // Consumers keep actions in dependency lists, so the value must change only
  // when a callback does — a re-render with the same callbacks keeps it.
  it('keeps the value while the callbacks keep their identity, and replaces it when one changes', async () => {
    const openReview = vi.fn()
    const navigateToRun = vi.fn()
    const mount = (review: () => void) => root.render(
      <WorkspaceActionsProvider openReview={review} navigateToRun={navigateToRun}><Probe /></WorkspaceActionsProvider>,
    )
    await act(async () => mount(openReview))
    await act(async () => mount(openReview))
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])

    const nextReview = vi.fn()
    await act(async () => mount(nextReview))
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[2].openReview).toBe(nextReview)
    expect(seen[2].navigateToRun).toBe(navigateToRun)
  })
})
