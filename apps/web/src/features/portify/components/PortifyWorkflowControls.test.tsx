// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortifyManifest } from '@/shared/api/client'
import * as api from '@/shared/api/client'
import { PortifyWorkflowControls } from './PortifyWorkflowControls'

const mocks = vi.hoisted(() => ({
  savePortify: vi.fn(),
  revisePortify: vi.fn(),
  cancelPortify: vi.fn(),
  openPortifyProject: vi.fn(),
  loadPortify: vi.fn(async () => {}),
  invalidate: vi.fn(),
}))

vi.mock('@/shared/api/client', () => ({
  savePortify: mocks.savePortify,
  revisePortify: mocks.revisePortify,
  cancelPortify: mocks.cancelPortify,
  openPortifyProject: mocks.openPortifyProject,
}))
vi.mock('../state/PortifyContext', () => ({
  usePortify: () => ({ loadPortify: mocks.loadPortify }),
}))
vi.mock('@/shared/state/invalidation', () => ({
  useInvalidation: () => ({ invalidate: mocks.invalidate }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
  mocks.savePortify.mockResolvedValue(manifest('saved'))
  mocks.cancelPortify.mockResolvedValue(manifest('aborted'))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function manifest(status: PortifyManifest['status'], over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'wf-1',
    feature: 'checkout',
    repos: [{ name: 'api', path: '/repo', worktreePath: '/worktree' }],
    agent: 'claude',
    branch: 'portify/wf-1',
    status,
    attempt: 1,
    maxAttempts: 3,
    startedAt: '2026-08-30T00:00:00Z',
    diff: '+ process.env.PORT',
    verification: {
      ok: true,
      instances: [
        { ok: true, ports: { api: 4001 } },
        { ok: true, ports: { api: 4002 } },
      ],
    },
    ...over,
  }
}

function click(label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!button) throw new Error(`button not found: ${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('PortifyWorkflowControls', () => {
  it('saves a parked standalone workflow and refreshes Flight evidence', async () => {
    const onChanged = vi.fn()
    await act(async () => {
      root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save')} onChanged={onChanged} />)
    })
    await act(async () => click('Save overlay'))

    expect(api.savePortify).toHaveBeenCalledWith('wf-1')
    expect(mocks.loadPortify).toHaveBeenCalledWith('wf-1')
    expect(mocks.invalidate.mock.calls).toEqual([
      ['ports'],
      ['repos'],
      ['flights'],
    ])
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps external review saveable but leaves revision to the external session', async () => {
    await act(async () => {
      root.render(
        <PortifyWorkflowControls
          manifest={manifest('ready-to-save', { producer: 'external' })}
          onChanged={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Save overlay')
    expect(container.textContent).not.toContain('Request changes')
  })

  it('cancels active internal work only after confirmation', async () => {
    await act(async () => {
      root.render(<PortifyWorkflowControls manifest={manifest('editing')} onChanged={vi.fn()} />)
    })
    await act(async () => click('Cancel port work'))
    expect(api.cancelPortify).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Discard this port work?')

    await act(async () => click('Discard'))
    expect(api.cancelPortify).toHaveBeenCalledWith('wf-1')
  })
})
