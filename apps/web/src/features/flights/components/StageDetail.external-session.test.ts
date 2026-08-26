import { describe, expect, it } from 'vitest'
import { externalSessionActivity } from './StageDetail'

describe('Flight external agent-session Activity provenance', () => {
  it('replaces a legacy synthetic Flight id with the real owning session', () => {
    const activity = externalSessionActivity(
      {
        kind: 'portifying',
        stage: 'portify',
        status: 'running',
        startedAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:01:00.000Z',
        clientKind: 'other',
        sessionId: 'flight:fl-old',
      },
      {
        clientKind: 'codex',
        sessionId: 'codex-session-1',
        conversationName: 'checkout flight',
        sessionUrl: 'https://chatgpt.com/codex/tasks/1',
      },
    )

    expect(activity).toMatchObject({
      clientKind: 'codex',
      sessionId: 'codex-session-1',
      conversationName: 'checkout flight',
      sessionUrl: 'https://chatgpt.com/codex/tasks/1',
      message: 'Work is continuing in your Codex session.',
    })
  })

  it('keeps an independently started task session instead of relabelling it', () => {
    const activity = externalSessionActivity(
      {
        kind: 'mapping',
        stage: 'specs-coverage',
        status: 'done',
        startedAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:01:00.000Z',
        clientKind: 'claude',
        sessionId: 'standalone-session',
        sessionUrl: 'https://claude.ai/chat/standalone',
      },
      {
        clientKind: 'codex',
        sessionId: 'flight-session',
        sessionUrl: 'https://chatgpt.com/codex/tasks/flight',
      },
    )

    expect(activity).toMatchObject({
      clientKind: 'claude',
      sessionId: 'standalone-session',
      sessionUrl: 'https://claude.ai/chat/standalone',
    })
  })

  it('does not present a synthetic Flight ownership key as a client session id', () => {
    const activity = externalSessionActivity({
      kind: 'exporting',
      stage: 'evaluation-export',
      status: 'running',
      startedAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      clientKind: 'other',
      sessionId: 'flight:fl-legacy',
    })

    expect(activity.sessionId).toBeUndefined()
  })
})
