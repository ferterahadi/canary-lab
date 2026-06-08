// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortifyManifest, PortifyStatus } from '../api/client'

vi.mock('../api/client', () => ({
  startPortify: vi.fn(),
  getPortify: vi.fn(),
  commitPortify: vi.fn(),
  cancelPortify: vi.fn(),
}))
// AgentSessionView opens a WS / fetches — stub it out in the wizard test.
vi.mock('./AgentSessionView', () => ({ AgentSessionView: () => null }))

import * as api from '../api/client'
import { PortifyWizard } from './PortifyWizard'

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
  vi.clearAllMocks()
})

function manifest(status: PortifyStatus, over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w', feature: 'cns', repos: [{ name: 'app', path: '~/app' }],
    agent: 'claude', branch: 'canary/dynamic-ports-cns', status, attempt: 1, maxAttempts: 3,
    startedAt: 't', ...over,
  }
}
const readyManifest = (): PortifyManifest => manifest('ready-to-commit', {
  diff: '# repo: app\n+ app.listen(process.env.PORT)',
  verification: { ok: true, instances: [{ ports: { api: 5001 }, ok: true }, { ports: { api: 5002 }, ok: true }] },
})

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button not found: ${label} (have: ${[...container.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')})`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

async function renderWizard(onClose = vi.fn(), onCommitted = vi.fn()) {
  await act(async () => {
    root.render(<PortifyWizard feature="cns" agent="claude" onClose={onClose} onCommitted={onCommitted} />)
  })
  return { onClose, onCommitted }
}

describe('PortifyWizard', () => {
  it('shows the plan screen first, then starts + reaches the review screen', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    await renderWizard()
    expect(container.textContent).toContain('What will happen')

    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(api.startPortify).toHaveBeenCalledWith({ feature: 'cns', agent: 'claude' })
    expect(container.textContent).toContain('Review')
    expect(container.textContent).toContain('Booted twice')
    expect(container.textContent).toContain('app.listen(process.env.PORT)')
  })

  it('revisit mode (workflowId) skips the plan screen and monitors the existing workflow', async () => {
    vi.mocked(api.getPortify).mockResolvedValue(manifest('verifying'))
    await act(async () => {
      root.render(<PortifyWizard workflowId="w" onClose={vi.fn()} onCommitted={vi.fn()} />)
    })
    await flush()
    expect(api.startPortify).not.toHaveBeenCalled()
    expect(api.getPortify).toHaveBeenCalledWith('w')
    expect(container.textContent).not.toContain('What will happen')
    expect(container.textContent).toContain('Running the exercise')
  })

  it('commits from the review screen and fires onCommitted', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    vi.mocked(api.commitPortify).mockResolvedValue(manifest('committed'))
    const { onCommitted } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    await act(async () => clickButton('Commit'))
    await flush()
    expect(api.commitPortify).toHaveBeenCalledWith('w')
    expect(onCommitted).toHaveBeenCalled()
  })

  it('surfaces a start error on the plan screen', async () => {
    vi.mocked(api.startPortify).mockRejectedValue(new Error('already running'))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('already running')
  })

  it('renders the exercise screen while editing/verifying', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('verifying', {
      verification: { ok: false, instances: [], failureDetail: 'port 3007 still bound' },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('Running the exercise')
    expect(container.textContent).toContain('Attempt 1 of 3')
    expect(container.textContent).toContain('port 3007 still bound')
  })

  it('shows the failed screen with the error + failure detail', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('failed', {
      error: 'verification did not pass after 3 attempt(s)',
      verification: { ok: false, instances: [], failureDetail: 'still clashing' },
      diff: '# repo: app\n+ x',
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('Could not make it work')
    expect(container.textContent).toContain('still clashing')
  })

  it('minimizes on Close — keeps the workflow running, does not cancel', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    const { onClose } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    await act(async () => clickButton('Close ✕'))
    expect(onClose).toHaveBeenCalled()
    expect(api.cancelPortify).not.toHaveBeenCalled()
    // No discard confirmation — closing just minimizes.
    expect(container.textContent).not.toContain('Discard this workflow?')
  })

  it('discards the workflow via Cancel → Discard', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    vi.mocked(api.cancelPortify).mockResolvedValue(manifest('aborted'))
    const { onClose } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    await act(async () => clickButton('Cancel'))
    expect(container.textContent).toContain('Discard this workflow?')
    await act(async () => clickButton('Discard'))
    await flush()
    expect(api.cancelPortify).toHaveBeenCalledWith('w')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the committed screen when the workflow is already committed', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('committed', {
      repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234' }],
    }))
    const { onCommitted } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('Committed')
    expect(container.textContent).toContain('abcdef1234'.slice(0, 10))
    await act(async () => clickButton('Done'))
    expect(onCommitted).toHaveBeenCalled()
  })
})
