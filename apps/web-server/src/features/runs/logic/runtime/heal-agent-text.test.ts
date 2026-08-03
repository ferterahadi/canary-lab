import { describe, it, expect } from 'vitest'
import { healAgentCauseSuffix, formatUserInterjectBlock, defaultHealPrompt } from './heal-agent-text'

// This wording is run evidence — it is what tells a user why a heal cycle gave
// up — so every recognized cause is pinned rather than left reachable only by
// driving a live agent to fail in that particular way.

describe('healAgentCauseSuffix', () => {
  it('names each cause the classifier recognizes', () => {
    expect(healAgentCauseSuffix('usage-limit')).toContain('usage limit')
    expect(healAgentCauseSuffix('auth')).toContain('not signed in')
    expect(healAgentCauseSuffix('rate-limit')).toContain('rate-limited')
    expect(healAgentCauseSuffix('crash')).toContain('crashed')
    // Says the agent never started, not that it tried and failed — the whole
    // point of telling a trust-prompt stall apart from a real repair attempt.
    expect(healAgentCauseSuffix('trust-prompt')).toContain('never started work')
  })

  it('stays silent when the cause was not recognized', () => {
    // We only editorialize about why an agent went quiet when we actually know.
    expect(healAgentCauseSuffix('unknown')).toBe('')
    expect(healAgentCauseSuffix(undefined)).toBe('')
  })
})

describe('formatUserInterjectBlock', () => {
  it('tags the block with elapsed time and gutters every line', () => {
    const started = '2026-07-26T00:00:00.000Z'
    const now = new Date('2026-07-26T00:01:05.000Z')

    expect(formatUserInterjectBlock('one\ntwo', started, now)).toBe(
      '\n[1:05] user interject\n  │ one\n  │ two\n\n',
    )
  })

  it('falls back to zero elapsed when the start timestamp is unparseable', () => {
    expect(formatUserInterjectBlock('hi', 'not-a-date', new Date('2026-07-26T00:05:00.000Z')))
      .toContain('[0:00]')
  })

  it('never reports negative elapsed when the clock moved backwards', () => {
    expect(formatUserInterjectBlock('hi', '2026-07-26T00:10:00.000Z', new Date('2026-07-26T00:00:00.000Z')))
      .toContain('[0:00]')
  })
})

describe('defaultHealPrompt', () => {
  it('echoes the cycle and output dir', () => {
    expect(defaultHealPrompt({ cycle: 2, outputDir: '/out' })).toBe(
      '[heal-agent placeholder cycle=2 mcp-out=/out]',
    )
  })

  it('appends guidance and the prior-session flag only when present', () => {
    const out = defaultHealPrompt({
      cycle: 3,
      outputDir: '/out',
      userGuidance: 'try the API',
      priorAgentSessionContext: 'ctx',
    })

    expect(out).toContain('guidance="try the API"')
    expect(out).toContain('prior-session=true')
  })
})
