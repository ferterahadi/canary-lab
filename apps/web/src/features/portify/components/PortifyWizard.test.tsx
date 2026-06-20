// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortifyManifest, PortifyStatus } from '../../../shared/api/client'

vi.mock('../../../shared/api/client', () => ({
  startPortify: vi.fn(),
  getPortify: vi.fn(),
  savePortify: vi.fn(),
  cancelPortify: vi.fn(),
  revisePortify: vi.fn(),
}))
// AgentSessionView opens a WS / fetches — stub it out in the wizard test.
vi.mock('../../agent-sessions/components/AgentSessionView', () => ({ AgentSessionView: () => null }))

// The wizard reads the single in-flight workflow to gate the Plan screen.
// Default to "nothing active" so existing Plan/Start tests are unaffected.
const mockActivePortify = vi.hoisted(() => ({ value: undefined as undefined | { workflowId: string; feature: string; status: PortifyStatus; startedAt: string } }))
vi.mock('../state/PortifyContext', () => ({
  useActivePortify: () => mockActivePortify.value,
}))

import * as api from '../../../shared/api/client'
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
  mockActivePortify.value = undefined
})

function manifest(status: PortifyStatus, over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w', feature: 'cns', repos: [{ name: 'app', path: '~/app' }],
    agent: 'claude', branch: 'canary/dynamic-ports-cns', status, attempt: 1, maxAttempts: 3,
    startedAt: 't', ...over,
  }
}
const readyManifest = (): PortifyManifest => manifest('ready-to-save', {
  diff: '# repo: app\n+ app.listen(process.env.PORT)',
  verification: { ok: true, instances: [{ ports: { api: 5001 }, ok: true }, { ports: { api: 5002 }, ok: true }] },
})

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button not found: ${label} (have: ${[...container.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')})`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
function clickByTitle(title: string): void {
  const el = container.querySelector(`[title="${title}"]`)
  if (!el) throw new Error(`element not found by title: ${title}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
const buttonLabels = (): string[] => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// Set a React-controlled textarea's value via the native setter, then fire the
// input event React listens for.
function fillTextarea(value: string): void {
  const ta = container.querySelector('textarea')
  if (!ta) throw new Error('textarea not found')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, value)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderWizard(onClose = vi.fn(), onSaved = vi.fn()) {
  await act(async () => {
    root.render(<PortifyWizard feature="cns" agent="claude" onClose={onClose} onSaved={onSaved} />)
  })
  return { onClose, onSaved }
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
      root.render(<PortifyWizard workflowId="w" onClose={vi.fn()} onSaved={vi.fn()} />)
    })
    await flush()
    expect(api.startPortify).not.toHaveBeenCalled()
    expect(api.getPortify).toHaveBeenCalledWith('w')
    expect(container.textContent).not.toContain('What will happen')
    expect(container.textContent).toContain('Running the exercise')
  })

  it('saves from the review screen and advances to the Save step (does not close)', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    vi.mocked(api.savePortify).mockResolvedValue(manifest('saved'))
    const { onSaved } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    await act(async () => clickButton('Save overlay'))
    await flush()
    expect(api.savePortify).toHaveBeenCalledWith('w')
    // Lands on the Save step — the wizard stays open instead of closing.
    expect(container.textContent).toContain('Saved as overlay')
    expect(container.textContent).toContain('features/cns/portify/')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('opens the feedback modal from Request changes and resumes the agent on submit', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    vi.mocked(api.revisePortify).mockResolvedValue(manifest('editing', { feedbackRounds: 1 }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    // No composer until Request changes is pressed.
    expect(container.querySelector('textarea')).toBeNull()

    await act(async () => clickButton('Request changes'))
    expect(container.textContent).toContain('Ask the agent for changes')
    expect(container.querySelector('textarea')).not.toBeNull()

    await act(async () => fillTextarea('  use PORT not GATEWAY_PORT  '))
    await act(async () => clickButton('Send & re-verify'))
    await flush()
    expect(api.revisePortify).toHaveBeenCalledWith('w', 'use PORT not GATEWAY_PORT') // trimmed
  })

  it('shows the worktree path on the review screen for local review', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('ready-to-save', {
      diff: '# repo: app\n+ x',
      repos: [{ name: 'app', path: '~/app', worktreePath: '/tmp/wt/app' }],
      verification: { ok: true, instances: [{ ports: { api: 1 }, ok: true }, { ports: { api: 2 }, ok: true }] },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('Review locally')
    expect(container.textContent).toContain('/tmp/wt/app')
  })

  it('blocks save and warns when the latest revision failed verification', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('ready-to-save', {
      diff: '# repo: app\n+ x', feedbackRounds: 2,
      verification: { ok: false, instances: [], failureDetail: 'port 3000 still bound' },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('pass the double-boot')
    expect(container.textContent).toContain('port 3000 still bound')
    expect(container.textContent).toContain('revision 2')
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save overlay') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('surfaces a start error on the plan screen', async () => {
    vi.mocked(api.startPortify).mockRejectedValue(new Error('already running'))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('already running')
    // The error renders in the dismissable banner, which can be cleared.
    const dismiss = container.querySelector('[aria-label="Dismiss error"]') as HTMLButtonElement
    expect(dismiss).toBeTruthy()
    await act(async () => dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).not.toContain('already running')
  })

  it('blocks the Plan screen and routes to the running workflow when one is active', async () => {
    mockActivePortify.value = { workflowId: 'w-active', feature: 'oms', status: 'editing', startedAt: 't' }
    const onOpenActive = vi.fn()
    await act(async () => {
      root.render(<PortifyWizard feature="cns" agent="claude" onOpenActive={onOpenActive} onClose={vi.fn()} onSaved={vi.fn()} />)
    })
    // Plan screen is gated — no Start button, the running feature is named.
    expect(buttonLabels()).not.toContain('Start ▶')
    expect(container.textContent).toContain('already running')
    expect(container.textContent).toContain('oms')
    // start_run is never even attempted while blocked.
    await act(async () => clickButton('Open oms →'))
    expect(onOpenActive).toHaveBeenCalledWith('w-active')
    expect(api.startPortify).not.toHaveBeenCalled()
  })

  it('does not block its own workflow when reopened (revisit mode)', async () => {
    // Even with an active workflow, revisit mode (workflowId set) shows the run.
    mockActivePortify.value = { workflowId: 'w', feature: 'cns', status: 'verifying', startedAt: 't' }
    vi.mocked(api.getPortify).mockResolvedValue(manifest('verifying'))
    await act(async () => {
      root.render(<PortifyWizard workflowId="w" onClose={vi.fn()} onSaved={vi.fn()} />)
    })
    await flush()
    expect(container.textContent).toContain('Running the exercise')
    expect(container.textContent).not.toContain('already running')
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

  it('shows an environment-failure title (not a port-rewrite failure) when notPortFixable', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('failed', {
      error: 'The stack could not boot because a dependency was unreachable (e.g. the database is down).',
      verification: {
        ok: false,
        instances: [],
        failureDetail: "boot failed: gateway — Can't reach database server at 10.0.1.42:3306",
        notPortFixable: true,
      },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    // Title must NOT blame the port rewrite — it's an environment problem.
    expect(container.textContent).toContain('Stack could not boot')
    expect(container.textContent).not.toContain('Could not make it work')
    expect(container.textContent).toContain("Can't reach database server")
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

  it('shows the save screen when the workflow is already saved, and Done calls onSaved', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('saved'))
    const { onSaved } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('Saved as overlay')
    expect(container.textContent).toContain('features/cns/portify/')
    await act(async () => clickButton('Done'))
    expect(onSaved).toHaveBeenCalled()
  })

  it('navigates Review ↔ Save on a saved workflow via the stepper', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('saved', {
      diff: '# repo: app\n+ app.listen(process.env.PORT)',
      verification: { ok: true, instances: [{ ports: { api: 1 }, ok: true }, { ports: { api: 2 }, ok: true }] },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    // Lands on the Save screen with the saved cue.
    expect(container.textContent).toContain('Saved as overlay')
    expect(container.textContent).toContain('saved ✓')

    // Go back to Review — read-only: diff is shown, but no Save / Request-changes.
    await act(async () => clickByTitle('Go to Review'))
    await flush()
    expect(container.textContent).toContain('app.listen(process.env.PORT)')
    expect(buttonLabels()).not.toContain('Save overlay')
    expect(buttonLabels()).not.toContain('Request changes')
    expect(buttonLabels()).toContain('View save details →')

    // The "View save details" button returns to the Save screen.
    await act(async () => clickButton('View save details →'))
    await flush()
    expect(container.textContent).toContain('Saved as overlay')
  })

  it('at ready-to-save the stepper exposes Exercise but not Save (not yet reached)', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.querySelector('[title="Go to Exercise"]')).toBeTruthy()
    expect(container.querySelector('[title="Go to Review"]')).toBeTruthy()
    // Save isn't reachable until the overlay is saved.
    expect(container.querySelector('[title="Go to Save"]')).toBeNull()

    // Peek at the agent log (Exercise) and come back to Review.
    await act(async () => clickByTitle('Go to Exercise'))
    await flush()
    expect(container.textContent).toContain('The exercise')
  })
})
