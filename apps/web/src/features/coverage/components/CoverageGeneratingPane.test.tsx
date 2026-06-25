// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobManifest } from '../../../shared/api/types'
import { CoverageGeneratingPane } from './CoverageGeneratingPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// AgentSessionView pulls a REST snapshot and (when live) opens a WS. Stub both so
// the mount is inert — we only assert that the pane reaches into AgentSessionView.
vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
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

describe('CoverageGeneratingPane', () => {
  it('shows the stepper + an elapsed timer', () => {
    render(BASE_JOB)
    expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="generating-phases"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="generating-elapsed"]')).toBeTruthy()
  })

  it('always mounts the AgentSessionView — no Hide/Show button, no Live/Timeline toggle, no raw log (items 3+4)', () => {
    // The summary + mapping agents are agentic, so their work streams through the
    // one agent timeline (AgentSessionView), always visible: no toggles, no <pre>.
    render({ ...BASE_JOB, sessionRef: { agent: 'claude', sessionId: 's1' } })
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="toggle-agent-activity"]')).toBeNull()
    expect(container.querySelector('[data-testid="activity-live"]')).toBeNull()
    expect(container.querySelector('[data-testid="activity-timeline"]')).toBeNull()
    expect(container.querySelector('[data-testid="generating-log"]')).toBeNull()
  })

  it('mounts the AgentSessionView even before a session is pinned (live waiting state)', () => {
    render(BASE_JOB) // no sessionRef yet
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeTruthy()
  })

  it('for an external-producer job, shows the branded monitor (not AgentSessionView) with an open-client CTA', () => {
    render({ ...BASE_JOB, producer: 'external', externalClientKind: 'claude', externalSessionId: 's1' })
    // External offload has no Canary agent session — show the monitor instead.
    expect(container.querySelector('[data-testid="coverage-external-monitor"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="coverage-agent-session"]')).toBeNull()
    expect(container.querySelector('[data-testid="coverage-external-log"]')).toBeTruthy()
    // The "check your external agent" affordance: a known client gets an open CTA.
    expect(container.textContent).toContain('Open Claude')
  })

  it('external job for an unknown client shows the monitor but no open CTA', () => {
    render({ ...BASE_JOB, producer: 'external', externalClientKind: 'other', externalSessionId: 's1' })
    expect(container.querySelector('[data-testid="coverage-external-monitor"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Open Claude')
    expect(container.textContent).not.toContain('Open Codex')
  })
})
