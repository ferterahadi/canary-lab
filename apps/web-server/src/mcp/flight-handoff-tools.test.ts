import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { TOOLS_BY_PROFILE, type CanaryLabMcpToolName } from './tool-profiles'

// A flight started with `stage_producer: "external"` parks six thinking stages
// on `external-work` checkpoints for the CLIENT to answer. Final Parallel setup
// is deliberately absent: once the Report exists, Canary owns that persistent
// background workflow so the client can release the foreground conversation.
//
// So: a profile that can START a flight must be able to ANSWER every hand-off
// that flight can produce. This test enforces both halves of that.

const STAGES_DIR = path.resolve(__dirname, '../features/flights/logic/stages')

/** Stage keys that hand work to the client, discovered from the source rather
 *  than listed here. A stage hands off iff it imports `./externalizable` — the
 *  one module that owns the checkpoint — and calls either the direct
 *  `handsOffToClient(ctx)` branch or the `externalizable()` wrapper scout uses.
 *  A mere import does not count: Portify imports legacy checkpoint helpers so it
 *  can migrate already-persisted external workflows, but creates no new handoff.
 *  Discovery is the point: a NEW hand-off stage fails this file on the commit
 *  that adds it, instead of shipping a silent internal fallback. */
function discoverHandOffStages(): string[] {
  return fs.readdirSync(STAGES_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => file !== 'externalizable.ts')
    .filter((file) => /\b(?:handsOffToClient|externalizable)\s*\(/.test(fs.readFileSync(path.join(STAGES_DIR, file), 'utf-8')))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort()
}

/** What a client must be able to CALL to answer each hand-off. The flight always
 *  supplies the checkpoint itself, so `respond_flight_checkpoint` is implied and
 *  omitted; these are the extra tools the work needs.
 *
 *  An empty list is a real answer, not a gap: `docs`, `prd-summary` and
 *  `specs-coverage` are answered with `write_feature_doc` / the checkpoint's own
 *  `data` payload, and `evaluation-export` returns its envelope inline. Only
 *  `run` makes the client drive a second, live server-side loop. */
const REQUIRED_TOOLS: Record<string, readonly CanaryLabMcpToolName[]> = {
  scout: [],
  docs: ['write_feature_doc'],
  'prd-summary': [],
  'specs-coverage': [],
  run: ['claim_heal', 'wait_for_heal_task', 'signal_run'],
  'evaluation-export': [],
}

describe('flight hand-off tools are reachable from the flight profile', () => {
  it('declares a tool requirement for every stage that hands off', () => {
    // Stage keys are the file names; `evaluation-export.ts` → `evaluation-export`.
    expect(discoverHandOffStages()).toEqual(Object.keys(REQUIRED_TOOLS).sort())
  })

  // The regression itself. `flight` is the narrowest profile that can call
  // start_flight, so it is the one that has to hold.
  it.each(Object.entries(REQUIRED_TOOLS))('the flight profile can answer the %s hand-off', (_stage, tools) => {
    const flight = new Set(TOOLS_BY_PROFILE.flight)
    for (const tool of tools) expect([...flight]).toContain(tool)
  })

  // lifecycle (the bare-server default) and full (the setup-installed profile)
  // are unions over flight, so they inherit the above. Asserted anyway: a
  // future refactor could stop composing either from FLIGHT_TOOLS without any
  // other test noticing.
  it.each(['lifecycle', 'full'] as const)('%s inherits every hand-off tool', (profile) => {
    const available = new Set(TOOLS_BY_PROFILE[profile])
    for (const tools of Object.values(REQUIRED_TOOLS)) {
      for (const tool of tools) expect([...available]).toContain(tool)
    }
  })

  // The other half of the rule: the flight owns the save decision — it re-checks
  // the workflow and the overlay mark itself — and the hand-off prose tells the
  // client never to call these. Handing over a tool it is instructed not to use
  // is worse than withholding it, so keep them out of the flight surface.
  it('withholds the portify decisions the flight owns', () => {
    const flight = new Set<string>(TOOLS_BY_PROFILE.flight)
    for (const tool of ['save_portify', 'cancel_portify', 'start_external_portify', 'remove_portification']) {
      expect(flight.has(tool)).toBe(false)
    }
  })
})
