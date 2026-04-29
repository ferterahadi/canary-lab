import { describe, expect, it } from 'vitest'
import { extractGeneratedFiles, extractPlan } from './wizard-output-parser'

describe('extractPlan', () => {
  it('parses a valid plan between markers', () => {
    const stream = `chatter before
<plan-output>
[
  { "step": "Open login page", "actions": ["navigate to /login"], "expectedOutcome": "form visible" },
  { "step": "Submit creds", "actions": ["fill email", "click submit"], "expectedOutcome": "lands on /dashboard" }
]
</plan-output>
chatter after`
    const r = extractPlan(stream)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(2)
    expect(r.value[0].step).toBe('Open login page')
    expect(r.value[1].actions).toEqual(['fill email', 'click submit'])
  })

  it('fails when open marker is missing', () => {
    const r = extractPlan('no markers here')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/marker not found/)
  })

  it('fails when close marker is missing', () => {
    const r = extractPlan('<plan-output>[]')
    expect(r.ok).toBe(false)
  })

  it('fails on empty body', () => {
    const r = extractPlan('<plan-output>   \n  </plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/empty/)
  })

  it('fails on invalid JSON', () => {
    const r = extractPlan('<plan-output>not json</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/parse failed/)
  })

  it('fails when top-level is not an array', () => {
    const r = extractPlan('<plan-output>{"x":1}</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/array/)
  })

  it('fails when an item has missing step', () => {
    const r = extractPlan('<plan-output>[{"actions":[],"expectedOutcome":"x"}]</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/step missing/)
  })

  it('fails when actions is not string[]', () => {
    const r = extractPlan('<plan-output>[{"step":"x","actions":[1,2],"expectedOutcome":"y"}]</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/string\[\]/)
  })

  it('fails when expectedOutcome is missing', () => {
    const r = extractPlan('<plan-output>[{"step":"x","actions":[]}]</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/expectedOutcome/)
  })

  it('fails when an item is null', () => {
    const r = extractPlan('<plan-output>[null]</plan-output>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/not an object/)
  })

  it('rejects empty step string', () => {
    const r = extractPlan('<plan-output>[{"step":"  ","actions":[],"expectedOutcome":"y"}]</plan-output>')
    expect(r.ok).toBe(false)
  })
})

describe('extractGeneratedFiles', () => {
  it('extracts a single file block', () => {
    const stream = `<file path="feature.config.cjs">
module.exports = { name: 'demo' };
</file>`
    const r = extractGeneratedFiles(stream)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(r.value[0].path).toBe('feature.config.cjs')
    expect(r.value[0].content).toBe("module.exports = { name: 'demo' };")
  })

  it('extracts multiple file blocks', () => {
    const stream = `<file path="feature.config.cjs">
A
</file>
chatter
<file path="e2e/login.spec.ts">
B
</file>`
    const r = extractGeneratedFiles(stream)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(2)
    expect(r.value[0].content).toBe('A')
    expect(r.value[1].path).toBe('e2e/login.spec.ts')
    expect(r.value[1].content).toBe('B')
  })

  it('preserves nested triple-backtick fences', () => {
    const stream = `<file path="x.md">
\`\`\`ts
const x = 1;
\`\`\`
</file>`
    const r = extractGeneratedFiles(stream)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0].content).toContain('```ts')
  })

  it('fails when no blocks found', () => {
    const r = extractGeneratedFiles('plain text')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/no .file. blocks/)
  })

  it('rejects absolute paths', () => {
    const r = extractGeneratedFiles('<file path="/etc/passwd">x</file>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/relative/)
  })

  it('rejects paths with ..', () => {
    const r = extractGeneratedFiles('<file path="../escape.ts">x</file>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/relative/)
  })

  it('rejects empty path', () => {
    const r = extractGeneratedFiles('<file path="  ">x</file>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/empty/)
  })
})
