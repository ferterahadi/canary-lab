// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortifyManifest } from '@shared/portify-index'
import * as portifyApi from '@/shared/api/portify'
import * as cleanupApi from '@/shared/api/cleanup'
import { PortifyWorkflowControls } from './PortifyWorkflowControls'
import { mountRoot } from '@/test-helpers/mount-root'

const mocks = vi.hoisted(() => ({
  savePortify: vi.fn(),
  revisePortify: vi.fn(),
  cancelPortify: vi.fn(),
  openPortifyProject: vi.fn(),
  loadPortify: vi.fn(async () => {}),
  invalidate: vi.fn(),
}))

vi.mock('@/shared/api/portify', () => ({
  savePortify: mocks.savePortify,
  revisePortify: mocks.revisePortify,
  cancelPortify: mocks.cancelPortify,
}))
vi.mock('@/shared/api/cleanup', () => ({
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

mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.savePortify.mockResolvedValue(manifest('saved'))
  mocks.cancelPortify.mockResolvedValue(manifest('aborted'))
})

function manifest(status: PortifyManifest['status'], over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'wf-1',
    feature: 'checkout',
    featureDir: '/workspace/features/checkout',
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

    expect(portifyApi.savePortify).toHaveBeenCalledWith('wf-1')
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
    expect(portifyApi.cancelPortify).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Discard this port work?')

    await act(async () => click('Discard'))
    expect(portifyApi.cancelPortify).toHaveBeenCalledWith('wf-1')
  })
})

it('preserves local review, editor errors, and verified empty-diff presentation', async () => {
  mocks.openPortifyProject.mockResolvedValue({ opened: false, paths: [], error: 'no editor' })
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save')} onChanged={vi.fn()} />))
  expect(container.textContent).toContain('/worktree')
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Open project in editor"]')!.click())
  expect(cleanupApi.openPortifyProject).toHaveBeenCalledWith('wf-1')
  expect(container.textContent).toContain('no editor')
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save', { diff: '' })} onChanged={vi.fn()} />))
  expect(container.textContent).toContain('No changes needed')
})
it('submits trimmed feedback and rehydrates the current workflow', async () => {
  mocks.revisePortify.mockResolvedValue(manifest('editing'))
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save')} onChanged={vi.fn()} />))
  await act(async () => click('Request changes'))
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '  use PORT  ')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => click('Send & re-verify'))
  expect(portifyApi.revisePortify).toHaveBeenCalledWith('wf-1', 'use PORT')
  expect(mocks.loadPortify).toHaveBeenCalledWith('wf-1')
  expect(container.querySelector('textarea')).toBeNull()
})
it('keeps save unavailable when revision verification failed', async () => {
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save', {
    feedbackRounds: 2, verification: { ok: false, instances: [], failureDetail: 'port still bound' },
  })} onChanged={vi.fn()} />))
  expect(container.textContent).toContain('port still bound')
  expect(container.textContent).toContain('revision 2')
  const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save overlay')!
  expect(save.disabled).toBe(true)
  await act(async () => save.click())
  expect(portifyApi.savePortify).not.toHaveBeenCalled()
})
it('preserves action errors without reporting success', async () => {
  mocks.savePortify.mockRejectedValueOnce(new Error('save failed'))
  const changed = vi.fn()
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest('ready-to-save')} onChanged={changed} />))
  await act(async () => click('Save overlay'))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('save failed')
  expect(changed).not.toHaveBeenCalled()
})
it.each(['saved', 'failed', 'aborted'] as const)('does not expose execution actions for %s', async (status) => {
  await act(async () => root.render(<PortifyWorkflowControls manifest={manifest(status)} onChanged={vi.fn()} />))
  expect(container.querySelector('button')).toBeNull()
})
