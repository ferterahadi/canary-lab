import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { INSTRUCTIONS_BY_PROFILE, INSTRUCTIONS_DELIVERED_WINDOW, WORKFLOW_GUIDES } from './instructions'
import { EXEC_TOOL_NAME, FULL_TOOLS } from './tool-profiles'
import { classifyWaitForHealTask, type CanaryLabMcpDeps } from './tools'
import { EXTERNAL_HEAL_NEXT_STEPS, buildSpecEditsWarning, normalizeRunCounts } from '../features/runs/logic/heal/external-heal-surface'
import type { RunDetail, RunStore } from '../features/runs/logic/run-store'
import type { RunManifest } from '../features/runs/logic/runtime/manifest'

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

const shippedSkills = findShippedSkills(AGENT_INTEGRATIONS)
const runLoopSkills = shippedSkills.filter((f) => path.basename(path.dirname(f)) === 'canary-lab-run')

describe('repair guardrail — the flight heal hand-off prompt', () => {
  // A stage_producer:"external" flight hands the whole heal engagement to the
  // client via prompts/flight-heal-handoff.md — the one place that client is
  // TOLD the repair rule before it claims the loop. Prose is deletable in a
  // template rewrite without breaking a single test — hence this pin, the
  // sibling of the MODE_COPY pin in auto-heal.test.ts.
  const template = fs.readFileSync(
    path.join(REPO_ROOT, 'apps', 'web-server', 'prompts', 'flight-heal-handoff.md'),
    'utf-8',
  )

  it('leads with fix-the-app-not-the-test, with the provably-wrong exception intact', () => {
    expect(template).toMatch(/fix app\/service code, not tests/i)
    expect(template).toMatch(/never delete, skip, weaken, or loosen/i)
    expect(template).toMatch(/provably wrong/i)
  })

  it('routes the client through the evidence loop, never a self-report', () => {
    expect(template).toContain('claim_heal')
    expect(template).toContain('wait_for_heal_task')
    expect(template).toContain('signal_run')
    expect(template).toContain('The signal requests runner verification')
    expect(template).toContain('Do not start services or run Playwright')
    // The submit is a "check the record" release, not an answer payload.
    expect(template).toMatch(/reads the verdict from the run record/i)
  })
})

describe('repair guardrail — MCP instructions', () => {
  // Any profile that can drive a heal loop must carry the rule. `repair` is the
  // dedicated one; `lifecycle`/`full` compose it in, so a broken composition
  // (dropping REPAIR_INSTRUCTIONS from the concatenation) fails here too.
  const healProfiles = ['repair', 'lifecycle', 'full', 'compact'] as const

  it.each(healProfiles)('%s instructions tell the agent to fix app code, not tests', (profile) => {
    const text = INSTRUCTIONS_BY_PROFILE[profile]
    expect(text).toContain('app/service code')
    expect(text).toMatch(/not tests, unless a test is provably wrong/i)
  })

  it('repair instructions forbid editing tests to clear the dirtyTests signal', () => {
    expect(INSTRUCTIONS_BY_PROFILE.repair).toMatch(/never edit the test files/i)
  })

  it('repair instructions read specEdits as untested edits: restore, or ask the human to adopt', () => {
    // The lead is what a skill-less client gets; the rule must be there, not
    // only in the guide.
    const lead = INSTRUCTIONS_BY_PROFILE.repair
    expect(lead).toMatch(/specEdits/)
    expect(lead).toMatch(/not tested/i)
    expect(lead).toMatch(/restore/i)
    expect(lead).toMatch(/ask the human to adopt/i)
    expect(lead).toMatch(/no (MCP )?tool can adopt/i)
  })

  it('the repair guide orders a restore on a weaker hint, never an edit to the test', () => {
    const guide = WORKFLOW_GUIDES.repair
    expect(guide).toMatch(/kind:"weaker"|weaker hint/i)
    expect(guide).toMatch(/restore/i)
    expect(guide).toMatch(/never a repair|never edit the test files/i)
    expect(guide).toMatch(/one AI labelled/i)
  })

  it('compact instructions carry the specEdits rule too', () => {
    const text = INSTRUCTIONS_BY_PROFILE.compact
    expect(text).toMatch(/specEdits/)
    expect(text).toMatch(/ask the human to adopt/i)
  })

  it('repair instructions keep the honest pass-count rule', () => {
    // Counts come from the real result lines; `total - failed` silently converts
    // never-run tests into passes.
    expect(INSTRUCTIONS_BY_PROFILE.repair).toMatch(/never total - failed/i)
  })

  it('repair instructions assign runtime verification to the runner', () => {
    expect(INSTRUCTIONS_BY_PROFILE.repair).toContain('The signal requests runner verification')
    expect(INSTRUCTIONS_BY_PROFILE.repair).toContain('Do not start services or run Playwright')
  })
})

// Presence in the string above is NOT delivery. The Claude Code CLI truncates a
// server's `instructions` at INSTRUCTIONS_DELIVERED_WINDOW chars (its logs read
// "Server instructions truncated from N to 2048 chars"). Every profile's lead now
// fits the window (instructions.test.ts), but the two rules pinned below once sat
// past the cut while every other test in this file stayed green — so each
// load-bearing rule also keeps a home in a channel the client provably gets: a
// tool result (results and tool descriptions are not truncated).
describe('repair guardrail — delivery, not just presence', () => {
  const DELIVERED_WINDOW = INSTRUCTIONS_DELIVERED_WINDOW

  const healProfiles = ['repair', 'lifecycle', 'full', 'compact'] as const

  it.each(healProfiles)('%s delivers the repair rule inside the un-truncated window', (profile) => {
    const at = INSTRUCTIONS_BY_PROFILE[profile].indexOf('app/service code')
    expect(at).toBeGreaterThanOrEqual(0)
    // Fails if a future prose edit pushes the rule past the cut — the rule would
    // still be "present" and every other test in this file would stay green.
    expect(at).toBeLessThan(DELIVERED_WINDOW)
  })

  // The repair lead carries these two, but a compact client (the setup-installed
  // default) reads the compact instructions, not the repair lead — so the heal
  // RESULT is the one channel every client gets. Do not "de-duplicate" them out
  // of the nextSteps on the grounds that session-init prose already says it.
  it('the pass-count invariant rides the heal result, not only session-init prose', () => {
    const steps = EXTERNAL_HEAL_NEXT_STEPS.join('\n')
    expect(steps).toMatch(/never total - failed/i)
    expect(steps).toMatch(/statusLine/)
    expect(steps).toMatch(/not run, not passed/i)
  })

  it('the repair rule rides the heal result for test failures, not just boot failures', () => {
    // bootFailureNextSteps carried "not a test failure — fix the service/app code"
    // already; the test-failure branch (the common case) did not.
    const steps = EXTERNAL_HEAL_NEXT_STEPS.join('\n')
    expect(steps).toMatch(/not tests, unless a test is provably wrong/i)
    expect(steps).toMatch(/never delete, skip, weaken, or loosen an assertion/i)
  })

  it('runner-owned verification rides the heal result', () => {
    const steps = EXTERNAL_HEAL_NEXT_STEPS.join('\n')
    expect(steps).toContain('The signal requests runner verification')
    expect(steps).toContain('Do not start services or run Playwright')
    expect(steps).toContain('targeted Playwright verification after the signal')
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

  it.each(runLoopSkills.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s reads specEdits as untested edits: restore, or ask the human to adopt',
    (_label, file) => {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toMatch(/specEdits/)
      expect(text).toMatch(/not tested/i)
      expect(text).toMatch(/restore/i)
      expect(text).toMatch(/ask the human to adopt/i)
      expect(text).toMatch(/no (MCP )?tool can adopt/i)
      expect(text).toMatch(/weaker/i)
    },
  )

  it.each(runLoopSkills.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s assigns runtime verification to the runner',
    (_label, file) => {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toContain('The signal requests runner verification')
      expect(text).toContain('Do not start services or run Playwright')
      expect(text).toContain('targeted Playwright verification after the signal')
    },
  )
})

// The spec-edit boundary (D9) and the integrity hint (D13). A run executes a
// run-start copy of its suite, so a live spec edit is inert until a HUMAN adopts
// it in Canary Lab; the differential's reading of that edit is a hint, never a
// gate. Two things would quietly undo this without failing any other test: an
// MCP tool that adopts/approves (the agent that weakened the spec then blesses
// its own edit), or a verdict path that consults the hint (a `withheld` status,
// a blocked export). Both are pinned here. Procedure: `cl_sync-agent-surfaces`.
describe('spec-edit boundary — humans adopt, hints advise', () => {
  const MCP_SRC = path.join(REPO_ROOT, 'apps', 'web-server', 'src', 'mcp')
  const VERDICT_SRC = path.join(REPO_ROOT, 'apps', 'web-server', 'src', 'features', 'runs', 'logic', 'runtime', 'run-verdict.ts')

  /** Every non-test source under the MCP layer, discovered — never hardcoded. */
  function findSources(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...findSources(full))
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full)
    }
    return out.sort()
  }

  it('exposes no tool that adopts, restores or approves a spec edit', () => {
    for (const name of [...FULL_TOOLS, EXEC_TOOL_NAME]) {
      expect(name).not.toMatch(/adopt|approve[-_]?(dirty|spec)|commit[-_]?dirty|restore[-_]?spec/i)
    }
  })

  it('no MCP source reaches the human-only adopt/restore/approve routes or the orchestrator levers', () => {
    const sources = findSources(MCP_SRC)
    expect(sources.length).toBeGreaterThan(20)
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8')
      // Compact profile's `exec` dispatches by internal tool name, so a route
      // reached through app.inject() would be reachable from every client.
      expect(text, path.relative(REPO_ROOT, file)).not.toMatch(/adopt-spec-edits|restore-spec-edits|approve-dirty|commit-dirty|adoptSpecEdits\(|restoreSpecEdits\(/)
    }
  })

  function passedWithWeakerHint(): RunManifest {
    return {
      runId: 'run-1',
      feature: 'checkout',
      startedAt: '2026-05-25T08:00:00.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
      specEdits: {
        checkedAt: 't',
        pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: ['a'], strength: { verdict: 'weaker', tests: [], baseline: 'run-start' } }],
        adopted: [],
      },
      integrity: {
        hints: [{ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', was: ['expect(x).toBe(1)'], now: [] }],
        disclosure: 'd',
      },
    }
  }

  it('the warning itself tells the agent no tool can adopt or approve, and orders a restore', () => {
    const warning = buildSpecEditsWarning(passedWithWeakerHint())
    const steps = warning?.nextSteps.join('\n') ?? ''
    expect(steps).toMatch(/No MCP tool can adopt or approve/)
    expect(steps).toMatch(/ask the human to adopt/)
    expect(steps).toMatch(/Restore/)
    // Nothing in the warning is a lever.
    expect(JSON.stringify(warning)).not.toMatch(/withheld|blocked|gate/i)
  })

  it('a weaker hint leaves a passed verdict passed, with its counts intact', () => {
    const summary = { complete: true, total: 1, passed: 1, passedNames: ['a'], failed: [] } as unknown as RunDetail['summary']
    const detail = { runId: 'run-1', manifest: passedWithWeakerHint(), summary } as unknown as RunDetail
    const deps = {
      store: { get: () => detail } as unknown as RunStore,
      broker: {},
      featuresDir: '/tmp/features',
      projectRoot: '/tmp',
      startRun: async () => ({ kind: 'started', runId: 'r' }),
    } as unknown as CanaryLabMcpDeps

    const result = classifyWaitForHealTask(deps, 'run-1', 's')

    expect(result).toMatchObject({
      ok: true,
      value: { type: 'passed', counts: normalizeRunCounts(summary), specEdits: { hints: [{ kind: 'weaker' }] } },
    })
    // The union has no `withheld` arm; the hint rides beside the verdict, not
    // in place of it.
    expect(JSON.stringify(result)).not.toMatch(/withheld/)
  })

  it('the verdict derivation takes no integrity input at all', () => {
    // decideRunStatus reads the exit code and the summary against the suite
    // copy — nothing else. A hint consulted here is a gate by another name.
    const text = fs.readFileSync(VERDICT_SRC, 'utf8')
    expect(text).not.toMatch(/integrity|IntegrityHint|specEdits|strength/)
  })
})
