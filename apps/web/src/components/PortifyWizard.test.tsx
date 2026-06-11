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
  revisePortify: vi.fn(),
  mergePortify: vi.fn(),
  getPortifyMergeStatus: vi.fn(),
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

function mergeStatusResult(over: Partial<api.PortifyMergeStatusResult> = {}): api.PortifyMergeStatusResult {
  return {
    workflowId: 'w',
    branch: 'canary/dynamic-ports-cns',
    repos: [{
      name: 'app', gitRoot: '/repos/app', commitSha: 'abcdef1234',
      branchExists: true, currentBranch: 'release/1.3.0', dirty: false, mergeInProgress: false, merged: false,
    }],
    merged: false,
    nothingToMerge: false,
    ...over,
  }
}

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

  it('commits from the review screen and advances to the merge step (does not close)', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    vi.mocked(api.commitPortify).mockResolvedValue(manifest('committed', {
      repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234' }],
    }))
    vi.mocked(api.getPortifyMergeStatus).mockResolvedValue(mergeStatusResult())
    const { onCommitted } = await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    await act(async () => clickButton('Commit'))
    await flush()
    expect(api.commitPortify).toHaveBeenCalledWith('w')
    // Lands on the Merge step — the wizard stays open instead of closing.
    expect(container.textContent).toContain('one step left')
    expect(buttonLabels()).toContain('Merge into release/1.3.0')
    expect(onCommitted).not.toHaveBeenCalled()
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
    vi.mocked(api.getPortify).mockResolvedValue(manifest('ready-to-commit', {
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

  it('committed screen exposes a copyable git merge command via the Merge manually modal', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('committed', {
      repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234' }],
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    // The command lives behind the "Merge manually" modal now, not inline.
    expect(container.textContent).not.toContain('git merge canary/dynamic-ports-cns')
    await act(async () => clickButton('Merge manually'))
    expect(container.textContent).toContain('git merge canary/dynamic-ports-cns')
  })

  it('blocks commit and warns when the latest revision failed verification', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('ready-to-commit', {
      diff: '# repo: app\n+ x', feedbackRounds: 2,
      verification: { ok: false, instances: [], failureDetail: 'port 3000 still bound' },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.textContent).toContain('pass the double-boot')
    expect(container.textContent).toContain('port 3000 still bound')
    expect(container.textContent).toContain('revision 2')
    const commitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Commit') as HTMLButtonElement
    expect(commitBtn.disabled).toBe(true)
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
    // Unmerged: closing is explicit about the remaining step.
    await act(async () => clickButton('Done — merge later'))
    expect(onCommitted).toHaveBeenCalled()
  })

  it('navigates Review ↔ Commit on a committed workflow via the stepper', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(manifest('committed', {
      diff: '# repo: app\n+ app.listen(process.env.PORT)',
      repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234' }],
      verification: { ok: true, instances: [{ ports: { api: 1 }, ok: true }, { ports: { api: 2 }, ok: true }] },
    }))
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    // Lands on the Merge screen; merge is pending so no merged cue yet.
    expect(container.textContent).toContain('one step left')
    expect(container.textContent).not.toContain('merged ✓')

    // Go back to Review — read-only: diff is shown, but no Commit / Request-changes.
    await act(async () => clickByTitle('Go to Review'))
    await flush()
    expect(container.textContent).toContain('app.listen(process.env.PORT)')
    expect(buttonLabels()).not.toContain('Commit')
    expect(buttonLabels()).not.toContain('Request changes')
    expect(buttonLabels()).toContain('View merge details →')

    // The "View merge details" button returns to the Merge screen.
    await act(async () => clickButton('View merge details →'))
    await flush()
    expect(container.textContent).toContain('one step left')

    // And the stepper Review number works too (Merge → Review again).
    await act(async () => clickByTitle('Go to Review'))
    await flush()
    expect(buttonLabels()).toContain('View merge details →')
  })

  it('at ready-to-commit the stepper exposes Exercise but not Commit (not yet reached)', async () => {
    vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
    vi.mocked(api.getPortify).mockResolvedValue(readyManifest())
    await renderWizard()
    await act(async () => clickButton('Start ▶'))
    await flush()
    expect(container.querySelector('[title="Go to Exercise"]')).toBeTruthy()
    expect(container.querySelector('[title="Go to Review"]')).toBeTruthy()
    // Merge isn't reachable until the workflow is committed.
    expect(container.querySelector('[title="Go to Merge"]')).toBeNull()

    // Peek at the agent log (Exercise) and come back to Review.
    await act(async () => clickByTitle('Go to Exercise'))
    await flush()
    expect(container.textContent).toContain('The exercise')
  })

  describe('merge screen (PR-style)', () => {
    const committedManifest = () => manifest('committed', {
      repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234' }],
    })

    async function renderCommitted() {
      vi.mocked(api.startPortify).mockResolvedValue({ workflowId: 'w' })
      vi.mocked(api.getPortify).mockResolvedValue(committedManifest())
      await renderWizard()
      await act(async () => clickButton('Start ▶'))
      await flush()
    }

    it('shows live readiness checks and a merge button naming the target branch', async () => {
      vi.mocked(api.getPortifyMergeStatus).mockResolvedValue(mergeStatusResult())
      await renderCommitted()
      expect(api.getPortifyMergeStatus).toHaveBeenCalledWith('w')
      expect(container.textContent).toContain('release/1.3.0')
      expect(container.textContent).toContain('Working tree clean')
      expect(buttonLabels()).toContain('Merge into release/1.3.0')
    })

    it('merges on click and flips to the merged state', async () => {
      vi.mocked(api.getPortifyMergeStatus)
        .mockResolvedValueOnce(mergeStatusResult())
        .mockResolvedValue(mergeStatusResult({ merged: true, repos: [{ ...mergeStatusResult().repos[0], merged: true }] }))
      vi.mocked(api.mergePortify).mockResolvedValue({
        ok: true,
        results: [{ name: 'app', ok: true, mergeCommitSha: 'fedcba4321', alreadyMerged: false }],
        manifest: manifest('committed', { mergedAt: 'now', repos: [{ name: 'app', path: '~/app', commitSha: 'abcdef1234', mergeCommitSha: 'fedcba4321' }] }),
      })
      await renderCommitted()
      await act(async () => clickButton('Merge into release/1.3.0'))
      await flush()
      expect(api.mergePortify).toHaveBeenCalledWith('w')
      expect(container.textContent).toContain('Merged')
      expect(container.textContent).toContain('boot concurrently')
      expect(container.textContent).toContain('merged ✓') // stepper cue
    })

    it('disables merging on a dirty tree and explains the blocker', async () => {
      vi.mocked(api.getPortifyMergeStatus).mockResolvedValue(mergeStatusResult({
        repos: [{ ...mergeStatusResult().repos[0], dirty: true }],
      }))
      await renderCommitted()
      expect(container.textContent).toContain('uncommitted changes')
      const mergeBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Merge into')) as HTMLButtonElement
      expect(mergeBtn.disabled).toBe(true)
    })

    it('reports an aborted conflict with the conflicted files, repo left unchanged', async () => {
      vi.mocked(api.getPortifyMergeStatus).mockResolvedValue(mergeStatusResult())
      vi.mocked(api.mergePortify).mockResolvedValue({
        ok: false,
        results: [{ name: 'app', ok: false, conflictFiles: ['src/server.js'] }],
        manifest: committedManifest(),
      })
      await renderCommitted()
      await act(async () => clickButton('Merge into release/1.3.0'))
      await flush()
      expect(container.textContent).toContain('src/server.js')
      expect(container.textContent).toContain('aborted')
      expect(container.textContent).toContain('unchanged')
    })

    it('shows the merged state straight away when already merged (e.g. manually)', async () => {
      vi.mocked(api.getPortifyMergeStatus).mockResolvedValue(mergeStatusResult({
        merged: true,
        repos: [{ ...mergeStatusResult().repos[0], merged: true }],
      }))
      await renderCommitted()
      expect(container.textContent).toContain('Merged')
      expect(buttonLabels().some((l) => l.startsWith('Merge into'))).toBe(false)
    })
  })
})
