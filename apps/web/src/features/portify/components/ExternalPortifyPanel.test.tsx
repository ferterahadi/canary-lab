// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PortifyManifest, PortifyStatus } from '../../../shared/api/client'
import { ExternalPortifyPanel } from './ExternalPortifyPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

function manifest(status: PortifyStatus, over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w',
    feature: 'cns',
    repos: [{ name: 'app', path: '~/app', worktreePath: '/logs/portify/w/worktrees/g0-app' }],
    agent: 'claude',
    producer: 'external',
    external: { clientKind: 'claude-cli', sessionId: 'sess-123456789', conversationName: 'make ports injectable' },
    branch: 'canary/dynamic-ports-cns',
    status,
    attempt: 0,
    maxAttempts: 1,
    startedAt: 't',
    ...over,
  }
}

function render(m: PortifyManifest): void {
  act(() => root.render(<ExternalPortifyPanel m={m} />))
}

describe('ExternalPortifyPanel', () => {
  it('shows the client identity, conversation name, and status pill', () => {
    render(manifest('editing'))
    const text = container.textContent ?? ''
    expect(text).toContain('Claude CLI')
    expect(text).toContain('make ports injectable')
    expect(text).toContain('Editing')
    expect(text).toContain('External port-ification session')
  })

  it('surfaces the worktree edit paths while editing', () => {
    render(manifest('editing'))
    const text = container.textContent ?? ''
    expect(text).toContain('Editing in')
    expect(text).toContain('/logs/portify/w/worktrees/g0-app')
  })

  it('hides the edit paths once the workflow is saved (worktree discarded)', () => {
    render(manifest('saved'))
    const text = container.textContent ?? ''
    expect(text).not.toContain('Editing in')
    expect(text).toContain('Saved')
  })

  it('surfaces a failed-verification detail so the client can fix + resubmit', () => {
    render(manifest('editing', {
      verification: { ok: false, instances: [], failureDetail: 'port 3007 still bound on the second boot' },
    }))
    expect(container.textContent ?? '').toContain('port 3007 still bound')
  })

  it('renders an "Open" link to the external session when a url is present', () => {
    render(manifest('editing', { external: { clientKind: 'claude-desktop', sessionId: 's1', sessionUrl: 'https://claude.ai/x' } }))
    const link = container.querySelector('a[href="https://claude.ai/x"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Open Claude Desktop')
  })
})
