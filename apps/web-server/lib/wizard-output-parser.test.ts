import { describe, expect, it } from 'vitest'
import {
  extractDevDependencies,
  extractGeneratedFiles,
  extractGeneratedSpecOutput,
  extractPlan,
  extractWizardSessionRef,
} from './wizard-output-parser'

describe('extractWizardSessionRef', () => {
  it('extracts a claude wizard session marker', () => {
    expect(extractWizardSessionRef('x\n[[canary-lab:wizard-session agent=claude id=sess-123]]\ny')).toEqual({
      kind: 'claude',
      id: 'sess-123',
    })
  })

  it('extracts a codex wizard thread marker', () => {
    expect(extractWizardSessionRef('[[canary-lab:wizard-session agent=codex id=thread-123]]')).toEqual({
      kind: 'codex',
      id: 'thread-123',
    })
  })

  it('returns null when no marker is present', () => {
    expect(extractWizardSessionRef('<plan-output>[]</plan-output>')).toBeNull()
  })
})

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

  it('accepts a valid unmarked plan array when the agent omits markers', () => {
    const r = extractPlan(`assistant final answer:
[
  {
    "coverageType": "happy-path",
    "step": "Open login page",
    "actions": ["Navigate to /login"],
    "expectedOutcome": "The login form is visible."
  }
]`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0].step).toBe('Open login page')
  })

  it('accepts an unmarked plan array inside a JSON fence', () => {
    const r = extractPlan(`Here is the plan:
\`\`\`json
[
  {
    "step": "Submit valid credentials",
    "actions": ["Fill the email field", "Fill the password field"],
    "expectedOutcome": "The dashboard is shown."
  }
]
\`\`\``)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0].actions).toEqual(['Fill the email field', 'Fill the password field'])
  })

  it('finds an unmarked plan after bracket-like content inside a string', () => {
    const r = extractPlan(`debug payload: ["not a plan with an escaped quote: \\""]
[
  {
    "step": "Open settings",
    "actions": ["Click the settings item with text \\"[beta]\\""],
    "expectedOutcome": "Settings is visible."
  }
]`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0].actions[0]).toContain('[beta]')
  })

  it('does not treat unrelated JSON arrays as plans', () => {
    const r = extractPlan('[\"react\", \"vite\"]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/marker not found/)
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

  it('accepts string coverageType and rejects non-string coverageType', () => {
    const valid = extractPlan('<plan-output>[{"coverageType":"api","step":"x","actions":[],"expectedOutcome":"y"}]</plan-output>')
    expect(valid.ok).toBe(true)
    if (!valid.ok) return
    expect(valid.value[0].coverageType).toBe('api')

    const invalid = extractPlan('<plan-output>[{"coverageType":1,"step":"x","actions":[],"expectedOutcome":"y"}]</plan-output>')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toMatch(/coverageType/)
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

describe('extractDevDependencies', () => {
  it('returns an empty list when the block is omitted', () => {
    const r = extractDevDependencies('<file path="x.ts">x</file>')
    expect(r).toEqual({ ok: true, value: [] })
  })

  it('parses package names from a dependency block', () => {
    const r = extractDevDependencies('<dev-dependencies>["amqplib","@types/node","mysql2"]</dev-dependencies>')
    expect(r).toEqual({ ok: true, value: ['amqplib', '@types/node', 'mysql2'] })
  })

  it('rejects invalid JSON', () => {
    const r = extractDevDependencies('<dev-dependencies>not json</dev-dependencies>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/parse failed/)
  })

  it('rejects non-array blocks', () => {
    const r = extractDevDependencies('<dev-dependencies>{"mysql2":"latest"}</dev-dependencies>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/array/)
  })

  it('rejects duplicate packages', () => {
    const r = extractDevDependencies('<dev-dependencies>["mysql2","mysql2"]</dev-dependencies>')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/duplicate/)
  })

  it('rejects paths, URLs, and shell fragments', () => {
    for (const name of ['../mysql2', 'https://example.com/pkg', 'mysql2; rm -rf /']) {
      const r = extractDevDependencies(`<dev-dependencies>${JSON.stringify([name])}</dev-dependencies>`)
      expect(r.ok).toBe(false)
    }
  })

  it('rejects multiple, empty, non-string, and blank dependency entries', () => {
    const multiple = extractDevDependencies('<dev-dependencies>["a"]</dev-dependencies><dev-dependencies>["b"]</dev-dependencies>')
    expect(multiple.ok).toBe(false)
    if (!multiple.ok) expect(multiple.error).toMatch(/multiple/)

    const emptyBody = extractDevDependencies('<dev-dependencies>   </dev-dependencies>')
    expect(emptyBody.ok).toBe(false)
    if (!emptyBody.ok) expect(emptyBody.error).toMatch(/empty/)

    const nonString = extractDevDependencies('<dev-dependencies>[1]</dev-dependencies>')
    expect(nonString.ok).toBe(false)
    if (!nonString.ok) expect(nonString.error).toMatch(/must be a string/)

    const blank = extractDevDependencies('<dev-dependencies>["  "]</dev-dependencies>')
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toMatch(/is empty/)
  })
})

describe('extractGeneratedSpecOutput', () => {
  it('extracts files and dependency metadata together', () => {
    const r = extractGeneratedSpecOutput(`<file path="e2e/a.spec.ts">x</file>
<dev-dependencies>
["amqplib"]
</dev-dependencies>`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.files[0].path).toBe('e2e/a.spec.ts')
    expect(r.value.devDependencies).toEqual(['amqplib'])
  })

  it('returns file and dev dependency parse failures', () => {
    const noFiles = extractGeneratedSpecOutput('<dev-dependencies>["amqplib"]</dev-dependencies>')
    expect(noFiles.ok).toBe(false)
    if (!noFiles.ok) expect(noFiles.error).toMatch(/no .file. blocks/)

    const badDeps = extractGeneratedSpecOutput('<file path="x.ts">x</file><dev-dependencies>bad</dev-dependencies>')
    expect(badDeps.ok).toBe(false)
    if (!badDeps.ok) expect(badDeps.error).toMatch(/parse failed/)
  })
})
