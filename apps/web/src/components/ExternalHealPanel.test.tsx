import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalHealPanel } from './ExternalHealPanel'
import type { ExternalHealSession } from '../api/types'

describe('ExternalHealPanel', () => {
  it('hides stale session status once the run is terminal', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="aborted"
        session={session({ status: 'waiting' })}
      />,
    )

    expect(html).not.toContain('Waiting')
    expect(html).not.toContain('Aborted')
    expect(html).toContain('is no longer active for this run')
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

  it('explains external mode before a client has claimed the run', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="healing"
      />,
    )

    expect(html).toContain('External Client')
    expect(html).toContain('No external client has claimed this run yet')
    expect(html).toContain('aria-label="External client"')
    expect(html).not.toContain('Open Claude')
    expect(html).not.toContain('Open Codex')
  })

  it('describes terminal no-claim external runs without duplicate wording', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="failed"
      />,
    )

    expect(html).toContain('External Client')
    expect(html).toContain('No external client is actively waiting for a signal')
    expect(html).not.toContain('Failed')
    expect(html).not.toContain('var(--danger)')
    expect(html).not.toContain('external external')
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
