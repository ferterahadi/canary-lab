import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { INSTRUCTIONS_BY_PROFILE } from './server'

// The repair rule — "fix app/service code, not tests, unless a test is provably
// wrong" — is the guardrail Canary Lab exists to enforce (docs/PRD.md, Problem +
// quality bar 1). An agent that edits the test instead of the app produces a green
// run that proves nothing.
//
// It is expressed in prose on two agent-facing surfaces that no other test covers:
// the MCP `initialize` instructions (what a skill-less client reads) and the shipped
// `canary-lab-run` skills (what a skill-carrying client reads). Prose is deletable in
// a refactor without breaking a single test — hence this file.
//
// The spawned auto-heal agent's copy of the rule is pinned separately, in
// `features/runs/logic/runtime/auto-heal.test.ts` (`MODE_COPY.service`).
//
// Procedure for changing any of this: `cl_sync-agent-surfaces`.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
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

const shippedSkills = findShippedSkills(AGENT_INTEGRATIONS)
const runLoopSkills = shippedSkills.filter((f) => path.basename(path.dirname(f)) === 'canary-lab-run')

describe('repair guardrail — MCP instructions', () => {
  // Any profile that can drive a heal loop must carry the rule. `repair` is the
  // dedicated one; `lifecycle`/`full` compose it in, so a broken composition
  // (dropping REPAIR_INSTRUCTIONS from the concatenation) fails here too.
  const healProfiles = ['repair', 'lifecycle', 'full'] as const

  it.each(healProfiles)('%s instructions tell the agent to fix app code, not tests', (profile) => {
    const text = INSTRUCTIONS_BY_PROFILE[profile]
    expect(text).toContain('app/service code')
    expect(text).toMatch(/not tests, unless a test is provably wrong/i)
  })

  it('repair instructions forbid editing tests to clear the dirtyTests signal', () => {
    expect(INSTRUCTIONS_BY_PROFILE.repair).toMatch(/never edit the test files/i)
  })

  it('repair instructions keep the honest pass-count rule', () => {
    // Counts come from the real result lines; `total - failed` silently converts
    // never-run tests into passes.
    expect(INSTRUCTIONS_BY_PROFILE.repair).toMatch(/never total - failed/i)
  })
})

describe('repair guardrail — shipped agent skills', () => {
  it('discovers the run-loop skill in every client channel', () => {
    // claude, codex, plugin. If a channel is added, it must carry the rule too —
    // this assertion fails until the new file exists, which is the point.
    expect(runLoopSkills.length).toBeGreaterThanOrEqual(3)
    const channels = runLoopSkills.map((f) => path.relative(AGENT_INTEGRATIONS, f).split(path.sep)[0])
    expect(new Set(channels)).toEqual(new Set(['claude', 'codex', 'plugin']))
  })

  it.each(runLoopSkills.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s tells the agent to fix app code, not tests',
    (_label, file) => {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toMatch(/not tests, unless the test is provably wrong/i)
    },
  )

  it.each(runLoopSkills.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s keeps the honest pass-count rule',
    (_label, file) => {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toMatch(/statusLine/)
      // Wording differs per channel ("never total - failed" vs "Never compute
      // passed count as `summary.total - summary.failed.length`"); pin the
      // prohibition, not one phrasing.
      expect(text).toMatch(/(never|do not|don't)[\s\S]{0,120}total\s*-\s*(summary\.)?failed/i)
      expect(text).toMatch(/not run, not passed/i)
    },
  )
})
