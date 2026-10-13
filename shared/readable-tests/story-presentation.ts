import type { ReadableStoryFlowKind, ReadableStoryItem, ReadableStoryRole, ReadableStorySpan } from './types'

/** The grammar colour a story keyword takes. The web maps each to a `--code-*`
 * token and the evaluation report to a class, so both colour a step alike. */
export type StoryTone = 'comment' | 'cyan' | 'keyword' | 'attention'

const FLOW_KEYWORDS: Record<Exclude<ReadableStoryFlowKind, 'scope'>, string> = {
  condition: 'IF',
  then: 'THEN',
  otherwise: 'ELSE',
  switch: 'SWITCH',
  case: 'WHEN',
  loop: 'REPEAT',
  retry: 'RETRY',
  try: 'TRY',
  catch: 'ON ERROR',
  finally: 'ALWAYS',
}

export function storyRoleLabel(role: ReadableStoryRole): 'TEST' | 'SETUP' | 'ACTION' | 'OUTPUT' | 'CHECK' | 'NOTE' {
  if (role === 'note') return 'NOTE'
  if (role === 'test') return 'TEST'
  if (role === 'setup') return 'SETUP'
  if (role === 'action') return 'ACTION'
  if (role === 'output') return 'OUTPUT'
  return 'CHECK'
}

/** The word a step leads with: its role, or the control flow it opens. */
export function storyKeyword(step: ReadableStoryItem): string {
  if (step.kind !== 'flow' || step.flowKind === 'scope') return storyRoleLabel(step.role)
  return FLOW_KEYWORDS[step.flowKind]
}

export function storyRoleTone(role: ReadableStoryRole): StoryTone {
  if (role === 'note') return 'comment'
  if (role === 'setup') return 'cyan'
  if (role === 'action' || role === 'output' || role === 'test') return 'keyword'
  return 'attention'
}

export function storyKeywordTone(step: ReadableStoryItem): StoryTone {
  if (step.kind !== 'flow') return storyRoleTone(step.role)
  if (step.flowKind === 'catch') return 'attention'
  return step.role === 'setup' ? 'cyan' : 'keyword'
}

/** The keyword already says "CHECK", so the sentence drops its own "Check that ". */
function redundantStoryPrefix(step: ReadableStoryItem): string {
  const keyword = storyKeyword(step)
  if (keyword === 'TEST' && step.text.startsWith('Test: ')) return 'Test: '
  if (keyword === 'CHECK' && step.text.startsWith('Check that ')) return 'Check that '
  if (keyword === 'OUTPUT' && step.text.startsWith('Output ')) return 'Output '
  return ''
}

export function storyDisplayText(step: ReadableStoryItem): string {
  return step.text.slice(redundantStoryPrefix(step).length)
}

export function storyDisplaySpans(step: ReadableStoryItem): ReadableStorySpan[] {
  let remaining = redundantStoryPrefix(step).length
  if (remaining === 0) return step.spans
  const spans: ReadableStorySpan[] = []
  for (const span of step.spans) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length
      continue
    }
    spans.push(remaining > 0 ? { ...span, text: span.text.slice(remaining) } : span)
    remaining = 0
  }
  return spans
}
