// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobManifest } from '../../../api/types'
import { CoverageGeneratingPane } from './CoverageGeneratingPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// AgentSessionView pulls a REST snapshot and (when live) opens a WS. Stub both so
// the mount is inert — we only assert that the pane reaches into AgentSessionView.
vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ...actual,
    getCoverageAgentSession: vi.fn(async () => null),
  }
})
vi.mock('../../agent-sessions/api/agent-session-socket', () => ({
  connectAgentSessionStream: vi.fn(() => ({ close() {} })),
}))

const BASE_JOB: CoverageJobManifest = {
  jobId: 'job-1',
  feature: 'checkout',
  kind: 'coverage',
  status: 'running',
  startedAt: '2026-01-01T00:00:00Z',
  log: 'booting agent\nmapping coverage',
}

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

function render(job: CoverageJobManifest): void {
  act(() => {
    root.render(<CoverageGeneratingPane feature="checkout" job={job} />)
  })
}

function clickToggle(): void {
  const btn = container.querySelector('[data-testid="toggle-agent-activity"]') as HTMLButtonElement
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CoverageGeneratingPane', () => {
  it('shows the stepper + an elapsed timer', () => {
    render(BASE_JOB)
    expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="generating-phases"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="generating-elapsed"]')).toBeTruthy()
  })

  it('defaults to the LIVE output (streamed log), with a Timeline switch when a session exists', () => {
    render({ ...BASE_JOB, sessionRef: { agent: 'claude', sessionId: 's1' } })
    // Live output (the streaming log) is the default — that's what token-streams.
    expect(container.querySelector('[data-testid="generating-log"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeNull()
    // Both view options are offered.
    expect(container.querySelector('[data-testid="activity-live"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="activity-timeline"]')).toBeTruthy()
  })

  it('switching to Timeline mounts the structured AgentSessionView', () => {
    render({ ...BASE_JOB, sessionRef: { agent: 'claude', sessionId: 's1' } })
    const timeline = container.querySelector('[data-testid="activity-timeline"]') as HTMLButtonElement
    act(() => { timeline.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="generating-log"]')).toBeNull()
  })

  it('no structured session: shows the live log with no view switch', () => {
    render(BASE_JOB)
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeNull()
    expect(container.querySelector('[data-testid="activity-timeline"]')).toBeNull()
    const log = container.querySelector('[data-testid="generating-log"]')
    expect(log).toBeTruthy()
    expect(log?.textContent).toContain('mapping coverage')
  })

  it('the toggle hides + reshows the agent activity', () => {
    render(BASE_JOB)
    expect(container.querySelector('[data-testid="generating-log"]')).toBeTruthy() // shown by default
    clickToggle()
    expect(container.querySelector('[data-testid="generating-log"]')).toBeNull()  // hidden
    clickToggle()
    expect(container.querySelector('[data-testid="generating-log"]')).toBeTruthy() // shown again
  })
})
