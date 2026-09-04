import { describe, expect, it } from 'vitest'
import {
  CANARY_LAB_MCP_WORKFLOWS,
  INITIALIZE_CUT_MARKER,
  INSTRUCTIONS_BY_PROFILE,
  INSTRUCTIONS_DELIVERED_WINDOW,
  WORKFLOW_GUIDES,
  splitAtInitializeCut,
} from './instructions'
import { CANARY_LAB_MCP_PROFILES } from './tool-profiles'

// The Claude Code CLI keeps only the first INSTRUCTIONS_DELIVERED_WINDOW chars of
// a server's initialize `instructions`. Before this split, repair/coverage/portify
// ran 2× the window and flight 3.7× — every rule past the cut was asserted by
// tests and never delivered. These tests make the window a build-time fact.
describe('MCP initialize instructions fit the delivered window', () => {
  it.each(CANARY_LAB_MCP_PROFILES)('%s instructions are non-empty and within the window', (profile) => {
    const text = INSTRUCTIONS_BY_PROFILE[profile]
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_DELIVERED_WINDOW)
  })

  it('no delivered text carries the cut marker', () => {
    for (const profile of CANARY_LAB_MCP_PROFILES) {
      expect(INSTRUCTIONS_BY_PROFILE[profile]).not.toContain(INITIALIZE_CUT_MARKER)
    }
    for (const workflow of CANARY_LAB_MCP_WORKFLOWS) {
      expect(WORKFLOW_GUIDES[workflow]).not.toContain(INITIALIZE_CUT_MARKER)
    }
  })

  it.each(CANARY_LAB_MCP_WORKFLOWS)('the %s guide opens with its lead and a cut lead points at the guide tool', (workflow) => {
    const lead = INSTRUCTIONS_BY_PROFILE[workflow]
    const guide = WORKFLOW_GUIDES[workflow]
    expect(guide.startsWith(lead)).toBe(true)
    // A lead that hides text past the cut must say where the rest lives, or the
    // client has no way to learn that more guidance exists.
    if (guide.length > lead.length) expect(lead).toContain(`get_workflow_guide(workflow:"${workflow}")`)
  })

  it('lifecycle and full share the one index, which names every workflow guide', () => {
    expect(INSTRUCTIONS_BY_PROFILE.full).toBe(INSTRUCTIONS_BY_PROFILE.lifecycle)
    for (const workflow of CANARY_LAB_MCP_WORKFLOWS) {
      expect(INSTRUCTIONS_BY_PROFILE.lifecycle).toContain(`- ${workflow} —`)
    }
    expect(INSTRUCTIONS_BY_PROFILE.compact).toContain('get_workflow_guide')
  })
})

describe('splitAtInitializeCut', () => {
  it('delivers a marker-less file whole on both surfaces', () => {
    expect(splitAtInitializeCut('short guidance', 'x.md')).toEqual({ lead: 'short guidance', guide: 'short guidance' })
  })

  it('cuts the lead at the marker and keeps everything but the marker in the guide', () => {
    const split = splitAtInitializeCut(`lead line\n\n${INITIALIZE_CUT_MARKER}\nDetails:\nmore`, 'x.md')
    expect(split).toEqual({ lead: 'lead line', guide: 'lead line\n\nDetails:\nmore' })
  })

  it('refuses a second marker, naming the file', () => {
    expect(() => splitAtInitializeCut(`a\n${INITIALIZE_CUT_MARKER}\nb\n${INITIALIZE_CUT_MARKER}\nc`, 'mcp-x-instructions.md'))
      .toThrow('mcp-x-instructions.md: expected one <!-- initialize-cut --> line, found 2')
  })
})
