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
