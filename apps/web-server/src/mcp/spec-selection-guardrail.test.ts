import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { INSTRUCTIONS_DELIVERED_WINDOW, WORKFLOW_GUIDES } from './instructions'
import { applyExternalDraftFiles, externalTestFileRules } from '../features/config/logic/feature-authoring'
import { SPEC_SELECTION_RULE } from '../shared/playwright-config'

// A suite declares ONE roster of tests and every run of it declares the same
// one. Playwright builds that roster by walking the suite with the config's
// selection fields applied, before the first test starts, and that walk is what
// the reporter records as `summary.knownTests` — the declared roster every
// count, export and review reads (`cl_run-evidence-invariants` §4). A
// `playwright.config.*` that narrows the walk by envset therefore does not hide
// tests from a run, it deletes them from the run's evidence.
//
// The agent writes that config, so the rule lives on agent-facing surfaces that
// no other test covers: the author workflow guide, the shipped
// `canary-lab-author` skills, and — because instructions are truncated and a
// tool result is not — the rules payload `create_feature` hands back. Prose is
// deletable in a refactor without breaking a single test, hence this file; the
// sibling pin for the repair rule is `repair-guardrail.test.ts`.
//
// Procedure for changing any of this: `cl_sync-agent-surfaces`.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const AGENT_INTEGRATIONS = path.join(REPO_ROOT, 'agent-integrations')

/** Every SKILL.md shipped to a client channel, discovered — never hardcoded. */
function findShippedSkills(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findShippedSkills(full))
    else if (entry.name === 'SKILL.md') out.push(full)
  }
  return out.sort()
}

const authorSkills = findShippedSkills(AGENT_INTEGRATIONS)
  .filter((f) => path.basename(path.dirname(f)) === 'canary-lab-author')

describe('spec-selection guardrail — the author workflow guide', () => {
  const guide = WORKFLOW_GUIDES.author

  it('forbids deriving spec selection from the envset, by every field name', () => {
    expect(guide).toMatch(/selection never depends on the envset/i)
    for (const field of ['testDir', 'testMatch', 'testIgnore', 'grep', 'grepInvert']) {
      expect(guide).toContain(field)
    }
    expect(guide).toContain('CANARY_LAB_MANIFEST_PATH')
  })

  it('names the evidence consequence, not just the prohibition', () => {
    // Without the "why", a later prose pass reads this as a style preference and
    // trims it. The roster IS the run's record of what the suite contains.
    expect(guide).toMatch(/deletes them from the record|absent rather than "not run"/i)
  })

  it('gives the expressible alternative that keeps the roster whole', () => {
    expect(guide).toMatch(/sibling feature/i)
    expect(guide).toMatch(/counts a skipped test as not passed/i)
    expect(guide).not.toMatch(/test\.skip\(process\.env/)
  })
})

describe('spec-selection guardrail — shipped agent skills', () => {
  it('discovers the authoring skill in every client channel', () => {
    expect(authorSkills.length).toBeGreaterThanOrEqual(3)
    const channels = authorSkills.map((f) => path.relative(AGENT_INTEGRATIONS, f).split(path.sep)[0])
    expect(new Set(channels)).toEqual(new Set(['claude', 'codex', 'plugin']))
  })

  it.each(authorSkills.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s forbids envset-dependent spec selection and gives the sibling-feature alternative',
    (_label, file) => {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toMatch(/selection never depends on the envset/i)
      expect(text).toMatch(/testMatch/)
      expect(text).toMatch(/test\.skip\(/)
      expect(text).toMatch(/deletes them from the record/i)
    },
  )
})

describe('spec-selection guardrail — delivery, not just presence', () => {
  // Instructions are truncated at INSTRUCTIONS_DELIVERED_WINDOW; a tool result
  // is not. `create_feature` returns these rules, so this is the channel an
  // authoring client provably gets. Do not "de-duplicate" the rule out of here
  // on the grounds that the guide already says it.
  it('the rule rides the create_feature rules payload', () => {
    expect(externalTestFileRules().specSelection).toBe(SPEC_SELECTION_RULE)
  })

  it('the rule is a sentence an agent can act on without fetching the guide', () => {
    expect(SPEC_SELECTION_RULE).toMatch(/testMatch/)
    expect(SPEC_SELECTION_RULE).toMatch(/sibling feature/)
    expect(SPEC_SELECTION_RULE).not.toMatch(/test\.skip\(condition/)
    expect(SPEC_SELECTION_RULE.length).toBeLessThan(INSTRUCTIONS_DELIVERED_WINDOW)
  })

  it('refuses a draft that carries an envset-dependent config, naming the field', async () => {
    // The prose above is advice; this is the door. An agent that ignores the
    // rule still cannot land the config through Canary Lab.
    const featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-draft-'))
    try {
      const result = await applyExternalDraftFiles({
        featureDir,
        files: [
          { path: 'e2e/checkout.spec.ts', content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n" },
          {
            path: 'playwright.config.ts',
            content: "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testMatch: mode ? a : b })\n",
          },
        ],
      })
      expect(result).toEqual({ ok: false, error: expect.stringContaining('computed testMatch') })
      expect(fs.existsSync(path.join(featureDir, 'playwright.config.ts'))).toBe(false)
      // Refused before ANY write — a half-applied draft would leave the suite in
      // a state neither the agent nor the human asked for.
      expect(fs.existsSync(path.join(featureDir, 'e2e'))).toBe(false)
    } finally {
      fs.rmSync(featureDir, { recursive: true, force: true })
    }
  })

  it('applies a draft whose config keeps selection constant', async () => {
    const featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-draft-'))
    try {
      const result = await applyExternalDraftFiles({
        featureDir,
        files: [
          { path: 'e2e/checkout.spec.ts', content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n" },
          {
            path: 'playwright.config.ts',
            content: "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testMatch: '**/*.spec.ts' })\n",
          },
        ],
      })
      expect(result.ok).toBe(true)
      expect(fs.existsSync(path.join(featureDir, 'playwright.config.ts'))).toBe(true)
    } finally {
      fs.rmSync(featureDir, { recursive: true, force: true })
    }
  })
})
