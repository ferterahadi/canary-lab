import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as workspaceApi from '@/shared/api/workspace'
import { ExternalAgentMonitor } from './ExternalAgentMonitor'
import { mountRoot } from '@/test-helpers/mount-root'

vi.mock('@/shared/api/workspace', async (original) => ({
  ...(await original<typeof import('@/shared/api/workspace')>()),
  openAgentApp: vi.fn(async () => ({ opened: true })),
}))
let container: HTMLDivElement
let root: Root
afterEach(() => {
  vi.clearAllMocks()
})
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })
function render(props: Partial<ComponentProps<typeof ExternalAgentMonitor>> = {}) {
  act(() => root.render(<ExternalAgentMonitor clientKind="claude" statusPill={<span>Working</span>}
    body="Tracked progress" displayLog="First line" logTestId="monitor-log" {...props} />))
}

describe('ExternalAgentMonitor', () => {
  it('prefers a session link and retains optional conversation and full session metadata', () => {
    render({ sessionUrl: 'https://example.test/session', sessionId: 'session-1234567890', conversationName: 'Review checkout' })
    const link = container.querySelector('a')!
    expect(link.href).toBe('https://example.test/session')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer')
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Review checkout')
    expect(container.querySelector('[title="session-1234567890"]')).not.toBeNull()
    expect(workspaceApi.openAgentApp).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('opens %s and disables the action while pending', async (clientKind) => {
    let resolve!: (result: { opened: boolean }) => void
    vi.mocked(workspaceApi.openAgentApp).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    render({ clientKind })
    const button = container.querySelector('button')!
    await act(async () => button.click())
    expect(workspaceApi.openAgentApp).toHaveBeenCalledWith(clientKind)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Opening…')
    await act(async () => resolve({ opened: true }))
    expect(button.disabled).toBe(false)
  })

  it('shows an open-client failure and clears it after a successful retry', async () => {
    vi.mocked(workspaceApi.openAgentApp).mockRejectedValueOnce(new Error('Unable to open'))
    render()
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('Unable to open')
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).not.toContain('Unable to open')
  })

  it.each(['other', 'claude-pty', 'codex-pty'] as const)('requires a URL for %s and omits absent metadata', (clientKind) => {
    render({ clientKind })
    expect(container.querySelector('button, a')).toBeNull()
    expect(container.textContent).not.toContain('Session:')
    render({ clientKind, sessionUrl: 'https://example.test/session' })
    expect(container.querySelector('a')).not.toBeNull()
  })

  it('updates content without replacing the log scroller', () => {
    render()
    const log = container.querySelector('pre')!
    log.scrollTop = 42
    render({ displayLog: 'First line\nSecond line', statusPill: <span>Ready</span>, body: 'Submitted' })
    expect(container.querySelector('pre')).toBe(log)
    expect(log.scrollTop).toBe(42)
    expect(log.textContent).toBe('First line\nSecond line')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('Submitted')
  })
})
