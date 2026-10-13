import type { AgentSessionEvent, SubagentThread } from '@shared/agent-session-types'
import { describe, expect, it } from 'vitest'

import {
  describeEvent,
  eventSpan,
  externalLifecycle,
  formatJson,
  languageFor,
  numberedLines,
  parseSystemLine,
  promptBody,
  summarizeInput,
  systemVerb,
  textKey,
  toolFilePath,
  toolVerb,
} from './activity-log'

const at = (minute: number): string => `2026-07-21T11:${String(minute).padStart(2, '0')}:00.000Z`
const thread = (events: AgentSessionEvent[], over: Partial<SubagentThread> = {}): SubagentThread => ({
  agentId: 'a', parentToolId: 't1', agentType: 'Explore', description: 'find things', events, ...over,
} as SubagentThread)

describe('toolVerb', () => {
  it('drops the MCP server prefix from a tool name', () => {
    expect(toolVerb('mcp__canary_lab__get_flight')).toBe('get_flight')
    expect(toolVerb('mcp__')).toBe('mcp__')
    expect(toolVerb('Read')).toBe('Read')
    expect(toolVerb('')).toBe('tool')
  })
})

describe('summarizeInput', () => {
  it('prefers the target a reader recognizes', () => {
    expect(summarizeInput({ file_path: '/repo/a.ts', limit: 5 })).toBe('/repo/a.ts')
    expect(summarizeInput({ command: 'npm test' })).toBe('npm test')
    expect(summarizeInput({ pattern: 'x'.repeat(100) })).toBe(`${'x'.repeat(79)}…`)
  })

  it('falls back to compact JSON, a string, or nothing', () => {
    expect(summarizeInput({ a: 1 })).toBe('{"a":1}')
    expect(summarizeInput({ a: 'y'.repeat(100) })).toHaveLength(80)
    expect(summarizeInput('  multi\n  line  ')).toBe('multi line')
    expect(summarizeInput(42)).toBe('42')
    expect(summarizeInput(null)).toBe('')
    expect(summarizeInput(undefined)).toBe('')
  })
})

describe('formatJson / toolFilePath', () => {
  it('pretty-prints a value and passes a string through', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(formatJson('raw')).toBe('raw')
    expect(formatJson(undefined)).toBe('undefined')
  })

  it('finds the file a call names, under either key', () => {
    expect(toolFilePath({ file_path: 'a.md' })).toBe('a.md')
    expect(toolFilePath({ path: 'b.ts' })).toBe('b.ts')
    expect(toolFilePath({ path: '' })).toBeUndefined()
    expect(toolFilePath('a.md')).toBeUndefined()
    expect(toolFilePath(null)).toBeUndefined()
  })
})

describe('eventSpan', () => {
  it('spans first to last stamp, and says nothing under two', () => {
    const text = (minute: number): AgentSessionEvent => ({ kind: 'assistant-message', timestamp: at(minute), text: '' })
    expect(eventSpan([text(33), text(31)])).toBe('2m 00s')
    expect(eventSpan([text(31), { ...text(32), timestamp: 'nope' }])).toBe('')
  })
})

describe('describeEvent', () => {
  const result = (output: string, isError = false): AgentSessionEvent => ({ kind: 'tool-result', timestamp: at(0), toolId: 't1', output, isError })
  const call = (input: unknown, name = 'Read'): AgentSessionEvent => ({ kind: 'tool-call', timestamp: at(0), toolId: 't1', name, input })

  it('reads the task prompt past its harness boilerplate', () => {
    const line = describeEvent({ kind: 'user-message', timestamp: at(0), text: '<recommended_plugins>x</recommended_plugins>\nSummarize the docs.' })
    expect(line).toEqual({ kind: 'prompt', verb: 'Instructions', summary: 'Summarize the docs.' })
    // A prompt that is ONLY boilerplate still previews something.
    expect(describeEvent({ kind: 'user-message', timestamp: at(0), text: '<a>only</a>' }).summary).toBe('<a>only</a>')
  })

  it('names prose, an API error and thinking', () => {
    expect(describeEvent({ kind: 'assistant-message', timestamp: at(0), text: 'Done.\nMore.' })).toEqual({ kind: 'agent', verb: 'Assistant', summary: 'Done.' })
    expect(describeEvent({ kind: 'assistant-message', timestamp: at(0), text: 'API Error: 529', apiError: true }))
      .toEqual({ kind: 'agent', verb: 'API error', summary: 'API Error: 529', danger: true, whole: true })
    expect(describeEvent({ kind: 'assistant-thinking', timestamp: at(0), text: 'hmm' }).verb).toBe('Thinking')
  })

  it('names a tool call by its verb and target, or as a subagent with its thread', () => {
    expect(describeEvent(call({ file_path: 'a.md', limit: 5 }))).toEqual({ kind: 'agent', verb: 'Read', summary: 'a.md' })
    const events: AgentSessionEvent[] = [{ kind: 'assistant-message', timestamp: at(31), text: 'x' }]
    expect(describeEvent(call({ file_path: 'a.md' }), [thread(events), thread([], { agentType: undefined, description: undefined })]))
      .toEqual({ kind: 'agent', verb: 'Subagent', summary: 'Explore · find things · 1 event · +1 more' })
    expect(describeEvent(call({ file_path: 'a.md', limit: 5 }), []).verb).toBe('Read')
  })

  it('previews a numbered read without its line numbers, and flags an error', () => {
    expect(describeEvent(result('     1\t# Title\n     2\tbody'))).toEqual({ kind: 'agent', verb: 'Result', summary: '# Title' })
    expect(describeEvent(result(''))).toEqual({ kind: 'agent', verb: 'Result', summary: '(empty)', whole: true })
    expect(describeEvent(result('boom', true))).toEqual({ kind: 'agent', verb: 'Error', summary: 'boom', danger: true, whole: true })
  })
})

// `whole` decides whether a row opens a modal: only when the row cut something.
describe('describeEvent — whole (the row already shows everything)', () => {
  const text = (body: string): AgentSessionEvent => ({ kind: 'assistant-message', timestamp: at(0), text: body })
  const call = (input: unknown, name = 'Read'): AgentSessionEvent => ({ kind: 'tool-call', timestamp: at(0), toolId: 't1', name, input })
  const whole = (event: AgentSessionEvent): boolean => describeEvent(event).whole === true

  it('is whole for one uncut line, and not once a second line or the length cap cuts it', () => {
    expect(whole(text('  Done.  '))).toBe(true)
    expect(whole(text('Done.\nNext.'))).toBe(false)
    expect(whole(text('x'.repeat(200)))).toBe(false)
    expect(whole({ kind: 'user-message', timestamp: at(0), text: 'Summarize the docs.' })).toBe(true)
    expect(whole({ kind: 'user-message', timestamp: at(0), text: '<a>x</a>\nSummarize.' })).toBe(false)
  })

  it('is whole for a call whose only argument is the target the row prints', () => {
    expect(whole(call({ file_path: '/repo/docs/tasks.md' }))).toBe(true)
    expect(whole(call({ command: 'npm test' }, 'Bash'))).toBe(true)
  })

  it('opens a call that carries anything the row leaves out', () => {
    expect(whole(call({ file_path: 'a.md', offset: 10 }))).toBe(false)
    expect(whole(call({ description: 'why' }, 'Task'))).toBe(false)
    expect(whole(call({ command: 'a\nb' }, 'Bash'))).toBe(false)
    expect(whole(call({ command: 'x'.repeat(100) }, 'Bash'))).toBe(false)
    expect(whole(call({ command: 1 }, 'Bash'))).toBe(false)
    // The row shortens an MCP name, so the modal holds the full one.
    expect(whole(call({ path: 'a' }, 'mcp__canary_lab__read'))).toBe(false)
    expect(whole(call('npm test', 'Bash'))).toBe(false)
    expect(whole(call(null, 'Bash'))).toBe(false)
  })

  it('opens a multi-line result, and a numbered read even of one line', () => {
    const result = (output: string): AgentSessionEvent => ({ kind: 'tool-result', timestamp: at(0), toolId: 't1', output })
    expect(whole(result('ok'))).toBe(true)
    expect(whole(result('a\nb'))).toBe(false)
    expect(whole(result('     1\tonly line'))).toBe(false)
  })
})

describe('promptBody', () => {
  it('strips every leading tagged block and keeps the rest whole', () => {
    expect(promptBody('<a>1</a>\n<b-c>2</b-c>\ntask\n<d>kept</d>')).toBe('\ntask\n<d>kept</d>')
    expect(promptBody('plain task')).toBe('plain task')
  })
})

describe('parseSystemLine / systemVerb', () => {
  it('splits a stamped, tagged conductor line', () => {
    expect(parseSystemLine('[docs@2026-07-22T20:35:24.000Z] collecting…'))
      .toEqual({ tag: 'docs', timestamp: '2026-07-22T20:35:24.000Z', text: 'collecting…' })
  })

  it('reads an unstamped or untagged line without inventing either', () => {
    expect(parseSystemLine('[boot-verify] ready')).toEqual({ tag: 'boot-verify', text: 'ready' })
    expect(parseSystemLine('plain note')).toEqual({ text: 'plain note' })
  })

  it('turns a tag into a word, and no tag into System', () => {
    expect(systemVerb('coverage')).toBe('Coverage')
    expect(systemVerb(undefined)).toBe('System')
  })
})

describe('textKey', () => {
  it('keys a line of any length short and stable, and tells lines apart', () => {
    const key = textKey('x'.repeat(5000))
    expect(key).toMatch(/^[0-9a-z]{1,7}$/)
    expect(textKey('x'.repeat(5000))).toBe(key)
    expect(textKey('a')).not.toBe(textKey('b'))
  })
})

describe('externalLifecycle', () => {
  it('names each phase of an external session', () => {
    expect(externalLifecycle('running', 'start')).toBe('Running')
    expect(externalLifecycle('done', 'start')).toBe('Started')
    expect(externalLifecycle('ready', 'end')).toBe('Result ready')
    expect(externalLifecycle('done', 'end')).toBe('Completed')
    expect(externalLifecycle('failed', 'end')).toBe('Failed')
    expect(externalLifecycle('aborted', 'end')).toBe('Stopped')
  })
})

describe('numberedLines', () => {
  it('splits both cat -n styles into a gutter and keeps a trailing block apart', () => {
    expect(numberedLines('    12\tfoo\n    13→bar\n\n<system-reminder>x</system-reminder>'))
      .toEqual({ numbers: [12, 13], lines: ['foo', 'bar'], tail: '<system-reminder>x</system-reminder>' })
  })

  it('returns null for output that is not a numbered read', () => {
    expect(numberedLines('just text')).toBeNull()
  })
})

describe('languageFor', () => {
  it('colours by the named file extension, and refuses one it does not know', () => {
    expect(languageFor('docs/README.MD', '')).toBe('markdown')
    expect(languageFor('src/a.tsx', '')).toBe('tsx')
    expect(languageFor('a.cjs', '')).toBe('typescript')
    expect(languageFor('a.yml', '')).toBe('yaml')
    expect(languageFor('a.py', '{}')).toBeNull()
  })

  it('falls back to JSON only when the text really parses', () => {
    expect(languageFor(undefined, ' {"a":1} ')).toBe('json')
    expect(languageFor('Makefile', '[1,2]')).toBe('json')
    expect(languageFor(undefined, '{not json')).toBeNull()
    expect(languageFor(undefined, 'hello')).toBeNull()
  })
})
