import { describe, expect, it } from 'vitest'
import { describeReadabilityIssue, inspectTestReadability } from './test-readability'

describe('test source readability', () => {
  it('splits the reported declarations without changing await or getter evaluation order', async () => {
    const source = `
const { thread } = await newThread(),
      id = thread.conversation.conversationId;
const invalid = envelope(),
      invalidId = invalid.events[0].message.id;
return [id, invalidId];
`
    // Keep the source inside an async function: top-level return is intentionally
    // invalid in an authored spec, while this test executes both real bodies.
    const wrapped = `async function scenario(newThread, envelope) { ${source} }`
    const result = await inspectTestReadability(wrapped, 'messages.spec.ts')
    expect(result.issues.filter((issue) => issue.rule === 'one-var')).toHaveLength(2)
    expect(result.remaining).toEqual([])
    expect(result.code).toContain('const id = thread.conversation.conversationId')
    expect(result.code).toContain('const invalidId = invalid.events[0].message.id')

    const execute = async (code: string) => {
      const calls: string[] = []
      const newThread = async () => {
        calls.push('newThread')
        return { thread: { get conversation() { calls.push('conversation'); return { conversationId: 'thread-1' } } } }
      }
      const envelope = () => {
        calls.push('envelope')
        return { events: [{ message: { id: 'message-1' } }] }
      }
      const scenario = new Function(`${code}; return scenario;`)()
      return { ids: await scenario(newThread, envelope), calls }
    }
    expect(await execute(result.code)).toEqual(await execute(wrapped))
    expect(await execute(result.code)).toEqual({ ids: ['thread-1', 'message-1'], calls: ['newThread', 'conversation', 'envelope'] })
    expect(await inspectTestReadability(result.code, 'messages.spec.ts')).toMatchObject({ changed: false, issues: [], remaining: [] })
  })

  it('changes declaration separators only, preserving comments, values and embedded fixture code', async () => {
    const source = `// why these values belong together
const first = { values: [1, 2], pattern: /a,b/ }, /* keep the second fixture */ second = 'const a = 1, b = 2'
const template = \`text, \${first.values.join(',')}\`, // keep the third fixture
third = ['left', 'right']
`
    const result = await inspectTestReadability(source, 'fixtures.test.ts')
    expect(result.remaining).toEqual([])
    expect(result.code).toContain('// why these values belong together')
    expect(result.code).toContain('/* keep the second fixture */')
    expect(result.code).toContain('// keep the third fixture')
    const execute = (code: string) => new Function(`${code}; return [first.values, first.pattern.source, second, template, third]`)()
    expect(execute(result.code)).toEqual(execute(source))
  })

  it('supports TypeScript and JSX without loading project configuration', async () => {
    const source = 'const element = <button aria-label="Save" />, label: string = "Save"'
    const result = await inspectTestReadability(source, '/tmp/component.test.tsx')
    expect(result.remaining).toEqual([])
    expect(result.code).toContain("const label: string = 'Save'")
    expect(result.code).toContain('aria-label="Save"')
  })

  it('keeps declaration and expression lists in for headers intact', async () => {
    const source = 'for (let first = 0, second = 2; first < second; first++, second--, tick()) { visit(first) }'
    const result = await inspectTestReadability(source, 'loop.test.ts', { rulesOnly: true })
    expect(result).toEqual({ code: source, changed: false, issues: [], remaining: [] })
  })

  it.each([
    'if (ready) var first = 1, second = 2',
    'export const first = 1, second = 2',
    'using first = acquire(), second = acquire()',
  ])('reports declarations needing a deliberate rewrite: %s', async (source) => {
    const result = await inspectTestReadability(source, 'special.spec.ts', { rulesOnly: true })
    expect(result.code).toBe(source)
    expect(result.remaining).toEqual([expect.objectContaining({ rule: 'one-var', severity: 'error', fixable: false })])
  })

  it('handles declarations within switch cases and blocks in rules-only mode', async () => {
    const source = 'switch (kind) { case 1: { let a = 1, b = 2; } break; default: var c = 3, d = 4; }'
    const result = await inspectTestReadability(source, 'switch.test.ts', { rulesOnly: true })
    expect(result.issues.filter((issue) => issue.rule === 'one-var')).toHaveLength(2)
    expect(result.remaining).toEqual([])
    expect(result.code).toContain('let a = 1;\nlet b = 2')
    expect(result.code).toContain('var c = 3;\nvar d = 4')
  })

  it('reports comma operators without rewriting a call or its this binding', async () => {
    const source = 'const result = (0, service.method)()'
    const result = await inspectTestReadability(source, 'calls.spec.ts', { rulesOnly: true })
    expect(result.code).toBe(source)
    expect(result.remaining).toEqual([expect.objectContaining({ rule: 'no-sequences', severity: 'error', fixable: false })])
    expect(describeReadabilityIssue('calls.spec.ts', result.remaining[0])).toContain('calls.spec.ts:1:17 error no-sequences:')
  })

  it('flags nested conditionals for review without treating ordinary ternaries as errors', async () => {
    const result = await inspectTestReadability('const result = flag ? 1 : (other ? 2 : 3)\nconst otherResult = flag ? 1 : 2', 'branches.test.ts', { rulesOnly: true })
    expect(result.changed).toBe(false)
    expect(result.remaining).toEqual([expect.objectContaining({ rule: 'no-nested-ternary', severity: 'warning', fixable: false })])
  })

  it('cannot be bypassed with inline linter configuration', async () => {
    const result = await inspectTestReadability('// eslint-disable one-var\nconst a = 1, b = 2', 'directives.test.ts', { rulesOnly: true })
    expect(result.changed).toBe(true)
    expect(result.issues).toEqual([expect.objectContaining({ rule: 'one-var' })])
    expect(result.remaining).toEqual([])
  })

  it('preserves semicolons and CRLF in declaration-only cleanup', async () => {
    const result = await inspectTestReadability('const a = 1, b = 2;\r\n', 'windows.spec.ts', { rulesOnly: true })
    expect(result.code).toBe('const a = 1;\r\nconst b = 2;\r\n')
    expect(result.remaining).toEqual([])
  })

  it('keeps invalid syntax byte-for-byte and reports its source location', async () => {
    const source = 'const broken = ;\nconst a = 1, b = 2'
    const result = await inspectTestReadability(source, 'broken.spec.ts')
    expect(result.code).toBe(source)
    expect(result.changed).toBe(false)
    expect(result.remaining).toEqual([expect.objectContaining({ rule: 'syntax', line: 1, severity: 'error', fixable: false })])
  })

  it('preserves the original source if the formatter cannot select a parser', async () => {
    const source = 'const a = 1, b = 2'
    const result = await inspectTestReadability(source, 'unknown.extension')
    expect(result.code).toBe(source)
    expect(result.remaining).toEqual([expect.objectContaining({ rule: 'format', severity: 'error', fixable: false })])
  })
})
