import { describe, expect, it } from 'vitest'
import {
  storyDisplaySpans,
  storyDisplayText,
  storyKeyword,
  storyKeywordTone,
  storyRoleLabel,
  storyRoleTone,
} from './story-presentation'
import type { ReadableStoryFlow, ReadableStoryFlowKind, ReadableStoryRole, ReadableStorySpan, ReadableStoryStep } from './types'

const SOURCE = { file: '/repo/e2e/checkout.spec.ts', startLine: 4, endLine: 4, snippet: 'x' }

function step(role: ReadableStoryRole, text: string, spans: ReadableStorySpan[] = [{ text }]): ReadableStoryStep {
  return { id: 's', role, text, spans, fidelity: 'derived', source: SOURCE }
}

function flow(flowKind: ReadableStoryFlowKind, role: ReadableStoryRole = 'action'): ReadableStoryFlow {
  return { id: 'f', kind: 'flow', flowKind, role, text: 'f', spans: [{ text: 'f' }], fidelity: 'derived', source: SOURCE, children: [] }
}

describe('keywords', () => {
  it('names every role', () => {
    const roles: ReadableStoryRole[] = ['test', 'setup', 'action', 'output', 'check', 'note']
    expect(roles.map(storyRoleLabel)).toEqual(['TEST', 'SETUP', 'ACTION', 'OUTPUT', 'CHECK', 'NOTE'])
  })

  it('leads a flow with the control it opens, and a scope with its role', () => {
    const kinds: ReadableStoryFlowKind[] = ['condition', 'then', 'otherwise', 'switch', 'case', 'loop', 'retry', 'try', 'catch', 'finally']
    expect(kinds.map((kind) => storyKeyword(flow(kind)))).toEqual(['IF', 'THEN', 'ELSE', 'SWITCH', 'WHEN', 'REPEAT', 'RETRY', 'TRY', 'ON ERROR', 'ALWAYS'])
    expect(storyKeyword(flow('scope', 'setup'))).toBe('SETUP')
    expect(storyKeyword(step('check', 'x'))).toBe('CHECK')
  })
})

describe('tones', () => {
  it('colours a step by its role', () => {
    const roles: ReadableStoryRole[] = ['note', 'setup', 'action', 'output', 'test', 'check']
    expect(roles.map(storyRoleTone)).toEqual(['comment', 'cyan', 'keyword', 'keyword', 'keyword', 'attention'])
    expect(storyKeywordTone(step('check', 'x'))).toBe('attention')
  })

  it('colours a flow as control, an error handler as attention and a setup scope as setup', () => {
    expect(storyKeywordTone(flow('catch', 'setup'))).toBe('attention')
    expect(storyKeywordTone(flow('scope', 'setup'))).toBe('cyan')
    expect(storyKeywordTone(flow('loop', 'check'))).toBe('keyword')
  })
})

describe('display text', () => {
  it('drops the prefix the keyword already says', () => {
    expect(storyDisplayText(step('check', 'Check that the total is 3'))).toBe('the total is 3')
    expect(storyDisplayText(step('test', 'Test: checkout'))).toBe('checkout')
    expect(storyDisplayText(step('output', 'Output the order'))).toBe('the order')
    expect(storyDisplayText(step('action', 'Check that it opens'))).toBe('Check that it opens')
  })

  it('cuts the prefix across span boundaries and keeps the spans after it', () => {
    const spans: ReadableStorySpan[] = [{ text: 'Check ' }, { text: 'that the ' }, { text: 'total', kind: 'variable' }]
    expect(storyDisplaySpans(step('check', 'Check that the total', spans))).toEqual([{ text: 'the ' }, { text: 'total', kind: 'variable' }])
  })

  it('keeps a span that starts right where the prefix ends', () => {
    const spans: ReadableStorySpan[] = [{ text: 'Check that ' }, { text: 'total', kind: 'variable' }]
    expect(storyDisplaySpans(step('check', 'Check that total', spans))).toEqual([{ text: 'total', kind: 'variable' }])
  })

  it('returns the spans untouched when there is no prefix', () => {
    const spans: ReadableStorySpan[] = [{ text: 'Open', kind: 'verb' }, { text: ' the cart' }]
    expect(storyDisplaySpans(step('action', 'Open the cart', spans))).toBe(spans)
  })
})
