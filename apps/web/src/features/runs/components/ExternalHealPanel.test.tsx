import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalHealPanel } from './ExternalHealPanel'
import type { ExternalHealSession } from '@shared/run-manifest'

describe('ExternalHealPanel', () => {
  it('shows the terminal run status instead of stale session status once the run is terminal', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="failed"
        session={session({ status: 'waiting' })}
      />,
    )

    expect(html).not.toContain('Waiting')
    expect(html).toContain('Failed')
    expect(html).not.toContain('Session ended.')
  })

  it('keeps the external session status while the run is active', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="healing"
        session={session({ status: 'waiting' })}
      />,
    )

    expect(html).toContain('Awaiting Agent')
    expect(html).toContain('var(--warning)')
    expect(html).not.toContain('Aborted')
  })

  it('uses the same waiting label and amber tone before an external agent claims the run', () => {
    const html = renderToStaticMarkup(<ExternalHealPanel runId="run-1" runStatus="healing" />)
    expect(html).toContain('Awaiting Agent')
    expect(html).toContain('var(--warning)')
  })

  it('uses the run presentation for an actively healing external session', () => {
    const html = renderToStaticMarkup(<ExternalHealPanel runId="run-1" runStatus="healing" session={session({ status: 'healing' })} />)
    expect(html).toContain('Healing')
    expect(html).toContain('var(--warning)')
  })

  it.each([
    ['claude', 'Claude', 'Open Claude'],
    ['codex', 'Codex', 'Open Codex'],
    ['claude-pty', 'Claude (runner)', null],
    ['codex-pty', 'Codex (runner)', null],
  ] as const)('renders the exact external client kind for %s', (clientKind, label, openButton) => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="healing"
        session={session({ clientKind })}
      />,
    )

    expect(html).toContain(label)
    expect(html).toContain(`alt="${label}"`)
    expect(html).not.toContain('Follow the repair')
    if (openButton) {
      expect(html).toContain(openButton)
    } else {
      expect(html).not.toContain('Open Claude')
      expect(html).not.toContain('Open Codex')
    }
    expect(html).not.toContain('Desktop/CLI')
    expect(html).not.toContain('External Client')
  })

  it('explains external mode before a client has claimed the run', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="healing"
      />,
    )

    expect(html).toContain('AI Agent')
    expect(html).toContain('Claim this run from an MCP-connected agent.')
    expect(html).not.toContain('Heartbeat')
    expect(html).not.toContain('Cycles')
    expect(html).toContain('aria-label="External agent session"')
    expect(html).not.toContain('Open Claude')
    expect(html).not.toContain('Open Codex')
  })

  it('hides session facts before a repair is requested', () => {
    const html = renderToStaticMarkup(<ExternalHealPanel runId="run-1" runStatus="running" />)
    expect(html).toContain('No agent has claimed this run.')
    expect(html).not.toContain('Awaiting Agent')
    expect(html).not.toContain('Heartbeat')
    expect(html).not.toContain('Cycles')
  })

  it('shows a recorded zero in the Cycles column', () => {
    const html = renderToStaticMarkup(<ExternalHealPanel runId="run-1" runStatus="healing" session={session({ cycleCount: 0 })} />)
    expect(html).toContain('Cycles')
    expect(html).toContain('>0<')
  })

  it('describes terminal no-claim external runs without duplicate wording', () => {
    const html = renderToStaticMarkup(
      <ExternalHealPanel
        runId="run-1"
        runStatus="failed"
      />,
    )

    expect(html).toContain('AI Agent')
    expect(html).not.toContain('No agent claimed this run.')
    expect(html).not.toContain('cl-card-body')
    expect(html).not.toContain('Heartbeat')
    expect(html).not.toContain('Cycles')
    expect(html).toContain('Failed')
    expect(html).toContain('var(--danger)')
    expect(html).not.toContain('external external')
  })
})

function session(overrides: Partial<ExternalHealSession> = {}): ExternalHealSession {
  return {
    sessionId: 's-1',
    clientKind: 'claude',
    conversationName: 'Healing via Claude',
    claimedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:01:00.000Z',
    status: 'connected',
    cycleCount: 1,
    ...overrides,
  }
}
