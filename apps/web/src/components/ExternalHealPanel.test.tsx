import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalHealPanel } from './ExternalHealPanel'
import type { ExternalHealSession } from '../api/types'

describe('ExternalHealPanel', () => {
  it('shows the terminal run status instead of a stale waiting session status', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="aborted"
        session={session({ status: 'waiting' })}
      />,
    )

    expect(html).toContain('Aborted')
    expect(html).not.toContain('Waiting')
    expect(html).toContain('This run was aborted')
    expect(html).toContain('var(--text-muted)')
    expect(html).not.toContain('var(--success)')
  })

  it('keeps the external session status while the run is active', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="healing"
        session={session({ status: 'waiting' })}
      />,
    )

    expect(html).toContain('Waiting')
    expect(html).not.toContain('Aborted')
  })
})

function session(overrides: Partial<ExternalHealSession> = {}): ExternalHealSession {
  return {
    sessionId: 's-1',
    clientKind: 'claude-desktop',
    conversationName: 'Healing via Claude',
    claimedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:01:00.000Z',
    status: 'connected',
    cycleCount: 1,
    ...overrides,
  }
}
