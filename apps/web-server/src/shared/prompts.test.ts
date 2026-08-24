import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROMPTS_DIR, promptPath, loadPromptTemplate, renderPromptTemplate, renderPrompt } from './prompts'

describe('promptPath', () => {
  it('joins a template name onto the packaged prompts dir', () => {
    expect(promptPath('heal-agent.md')).toBe(path.join(PROMPTS_DIR, 'heal-agent.md'))
  })
})

describe('loadPromptTemplate', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-prompts-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reads and trims a template file', () => {
    const file = path.join(tmp, 'x.md')
    fs.writeFileSync(file, '\n  hello {{name}}  \n')
    expect(loadPromptTemplate(file)).toBe('hello {{name}}')
  })

  it('throws a descriptive error when the file is missing', () => {
    expect(() => loadPromptTemplate(path.join(tmp, 'missing.md'))).toThrow(/Prompt template not found/)
  })

  it.each([
    'mcp-repair-instructions.md',
    'mcp-verify-instructions.md',
    'mcp-author-instructions.md',
    'mcp-coverage-instructions.md',
    'mcp-export-instructions.md',
    'mcp-flight-instructions.md',
    'mcp-portify-instructions.md',
    'mcp-compact-instructions.md',
  ])('ships the static MCP instruction source %s', (file) => {
    expect(loadPromptTemplate(promptPath(file))).not.toBe('')
  })

  it('teaches the compact dispatcher with a schema shape, not a sample feature', () => {
    const prompt = loadPromptTemplate(promptPath('mcp-compact-instructions.md'))
    expect(prompt).toContain('{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}')
    expect(prompt).not.toContain('workflow-workbench')
  })
})

describe('renderPromptTemplate', () => {
  it('replaces known placeholders', () => {
    expect(renderPromptTemplate('hello {{name}}!', { name: 'world' })).toBe('hello world!')
  })

  it('replaces multiple placeholders', () => {
    expect(renderPromptTemplate('{{a}} + {{b}} = {{c}}', { a: '1', b: '2', c: '3' })).toBe('1 + 2 = 3')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(renderPromptTemplate('hi {{unknown}}', { name: 'x' })).toBe('hi {{unknown}}')
  })

  it('substitutes an empty value inline without dropping the line', () => {
    expect(renderPromptTemplate('a={{x}}', { x: '' })).toBe('a=')
  })

  it('drops a line that holds nothing but a placeholder resolving to empty', () => {
    const template = ['before', '{{optional}}', 'after'].join('\n')
    expect(renderPromptTemplate(template, { optional: '' })).toBe('before\nafter')
  })

  it('keeps a solo-placeholder line when it resolves to non-empty text', () => {
    const template = ['before', '{{optional}}', 'after'].join('\n')
    expect(renderPromptTemplate(template, { optional: 'filled in' })).toBe('before\nfilled in\nafter')
  })
})

describe('renderPrompt', () => {
  it('loads a real packaged template and substitutes into it', () => {
    const out = renderPrompt('portify-retry.md', { featureConfigPath: '/f/feature.config.cjs', failureDetail: 'port 3007 still bound' })
    expect(out).toContain('/f/feature.config.cjs')
    expect(out).toContain('port 3007 still bound')
  })
})

// Every *.schema.json under prompts/ is handed to `codex exec --output-schema`,
// where OpenAI's strict structured-output mode enforces rules plain JSON Schema
// does not: every object with `properties` must list EVERY key in `required`
// (optionality is expressed as a `null` type union instead). A violation is a
// guaranteed 400 (`invalid_json_schema`) at the first codex turn — the agent
// can never succeed. Regression: coverage-annotate.schema.json shipped with
// partial `required` and killed every codex coverage-mapping attempt.
describe('codex output schemas (prompts/*.schema.json)', () => {
  const schemaFiles = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.schema.json'))

  function collectStrictViolations(node: unknown, ctx: string, out: string[]): void {
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    if (o.properties && typeof o.properties === 'object') {
      const keys = Object.keys(o.properties as Record<string, unknown>)
      const required = Array.isArray(o.required) ? (o.required as string[]) : []
      const missing = keys.filter((k) => !required.includes(k))
      if (missing.length) out.push(`${ctx}: required is missing [${missing.join(', ')}]`)
    }
    for (const [key, value] of Object.entries(o)) {
      if (value && typeof value === 'object') collectStrictViolations(value, `${ctx}.${key}`, out)
    }
  }

  it('ships at least the known schemas', () => {
    expect(schemaFiles).toEqual(expect.arrayContaining([
      'coverage-annotate.schema.json',
      'evaluation-rewrite.schema.json',
      'prd-summary.schema.json',
    ]))
  })

  it.each(schemaFiles)('%s satisfies OpenAI strict mode (every property key in required)', (file) => {
    const schema = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8')) as unknown
    const violations: string[] = []
    collectStrictViolations(schema, '$', violations)
    expect(violations).toEqual([])
  })
})
