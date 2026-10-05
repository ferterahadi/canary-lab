import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalOpenAction } from './AgentSessionRows'
import type { ExternalSessionActivity } from './activity-log'
import * as workspaceApi from '@/shared/api/workspace'

vi.mock('@/shared/api/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/workspace')>()),
  openAgentApp: vi.fn(async () => ({ opened: true })),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function render(clientKind: ExternalSessionActivity['clientKind'], sessionUrl?: string) {
  act(() => root.render(<ExternalOpenAction session={{
    sessionId: 'session-1', clientKind, sessionUrl, status: 'running', message: 'Working',
  }} />))
}

describe('external client actions', () => {
  it('prefers an exact session link and preserves its accessibility and target', () => {
    render('claude', 'https://example.test/session')
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.test/session')
    expect(link.getAttribute('aria-label')).toBe('Open Claude session')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer')
    expect(container.querySelector('button')).toBeNull()
    expect(workspaceApi.openAgentApp).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('launches %s and disables the button until completion', async (agent) => {
    let finish!: () => void
    vi.mocked(workspaceApi.openAgentApp).mockImplementationOnce(() => new Promise<{ opened: boolean }>((resolve) => { finish = () => resolve({ opened: true }) }))
    render(agent)
    const button = container.querySelector('button')!
    expect(button.textContent).toContain(`Open ${agent === 'claude' ? 'Claude' : 'Codex'} app`)
    await act(async () => button.click())
    expect(workspaceApi.openAgentApp).toHaveBeenCalledWith(agent)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Opening… ')
    await act(async () => finish())
    expect(button.disabled).toBe(false)
  })

  it('renders launch errors in the existing alert and clears them on retry', async () => {
    vi.mocked(workspaceApi.openAgentApp).mockRejectedValueOnce(new Error('launch denied'))
    render('codex')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('launch denied')
    expect(container.querySelector('button')!.disabled).toBe(false)
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it.each(['other', 'claude-pty', 'codex-pty'] as const)('only offers an action for %s when a session URL is supplied', (kind) => {
    render(kind)
    expect(container.textContent).toBe('')
    render(kind, 'https://example.test/session')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/session')
  })

  it('updates the mounted action when the client and session link change', async () => {
    render('claude', 'https://example.test/first')
    render('codex', 'https://example.test/second')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/second')
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Open Codex session')
    render('codex')
    expect(container.querySelector('a')).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(workspaceApi.openAgentApp).toHaveBeenCalledWith('codex')
    render('other')
    expect(container.textContent).toBe('')
  })
})
