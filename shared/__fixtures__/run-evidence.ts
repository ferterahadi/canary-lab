import type { PlaywrightPlaybackEvent } from '../playback'
import type { RunLifecycleEvent } from '../run-state'
import type { RunSummary } from '../run-detail'

// One synthetic run that carries every identity hazard the run panel has to
// keep apart. Three Playwright executions share one append-only event stream,
// exactly as `playwright-events.jsonl` stores them — nothing in the stream
// marks where one execution ends and the next begins, so the lifecycle events
// below (written by the orchestrator at each Playwright start and exit) are
// the only boundary a reader of a recorded run has.
//
//   execution 1 (full suite)    discount ✗  inventory ✗ then ✗ on retry 1  both "loads" ✓
//   heal cycle 1                journal iteration 1, input: discount + inventory
//   execution 2 (targeted)      discount ✗  inventory ✓
//   heal cycle 2                journal iteration 2, input: discount
//   execution 3 (targeted)      discount ✓
//
// The two "loads the page" cases share a title (and therefore a summary name
// and a service-log marker slug) but live in different files. Neither is rerun
// after execution 1, so its result is carried forward, not re-observed.

const discount = { name: 'test-case-applies-the-discount', title: 'applies the discount', location: 'e2e/checkout.spec.ts:12' }
const inventory = { name: 'test-case-reserves-stock', title: 'reserves stock', location: 'e2e/inventory.spec.ts:8' }
const homeLoads = { name: 'test-case-loads-the-page', title: 'loads the page', location: 'e2e/home.spec.ts:5' }
const adminLoads = { name: 'test-case-loads-the-page', title: 'loads the page', location: 'e2e/admin.spec.ts:5' }

export const evidenceCases = { discount, inventory, homeLoads, adminLoads }

export const evidenceKnownTests: NonNullable<RunSummary['knownTests']> = [
  { id: 'discount', ...discount },
  { id: 'inventory', ...inventory },
  { id: 'home-loads', ...homeLoads },
  { id: 'admin-loads', ...adminLoads },
]

type TestRef = { name: string; title: string; location: string }

function attempt(test: TestRef & { id?: string }, begin: string, end: string, passed: boolean, retry = 0, message?: string): PlaywrightPlaybackEvent[] {
  const step = { title: 'Click getByRole(\'button\', { name: \'Pay\' })', category: 'pw:api' }
  const stepTest = { ...(test.id ? { id: test.id } : {}), name: test.name, title: test.title }
  return [
    { type: 'test-begin', time: begin, test },
    { type: 'step-begin', time: begin, test: stepTest, step },
    { type: 'step-end', time: end, test: stepTest, step },
    {
      type: 'test-end', time: end, test, status: passed ? 'passed' : 'failed', passed, durationMs: 1000, retry,
      ...(message ? { error: { message } } : {}),
    },
  ]
}

const withId = (test: TestRef, id: string) => ({ id, ...test })

export const evidencePlaybackEvents: PlaywrightPlaybackEvent[] = [
  // execution 1
  ...attempt(withId(discount, 'discount'), '2026-10-08T10:00:01.000Z', '2026-10-08T10:00:02.000Z', false, 0, 'Expected total 90, received 100'),
  ...attempt(withId(inventory, 'inventory'), '2026-10-08T10:00:03.000Z', '2026-10-08T10:00:04.000Z', false, 0, 'Expected 409, received 500'),
  ...attempt(withId(inventory, 'inventory'), '2026-10-08T10:00:05.000Z', '2026-10-08T10:00:06.000Z', false, 1, 'Expected 409, received 500'),
  ...attempt(withId(homeLoads, 'home-loads'), '2026-10-08T10:00:07.000Z', '2026-10-08T10:00:08.000Z', true),
  ...attempt(withId(adminLoads, 'admin-loads'), '2026-10-08T10:00:09.000Z', '2026-10-08T10:00:10.000Z', true),
  // execution 2 — after heal cycle 1
  ...attempt(withId(discount, 'discount'), '2026-10-08T10:05:01.000Z', '2026-10-08T10:05:02.000Z', false, 0, 'Expected total 90, received 95'),
  ...attempt(withId(inventory, 'inventory'), '2026-10-08T10:05:03.000Z', '2026-10-08T10:05:04.000Z', true),
  // execution 3 — after heal cycle 2
  ...attempt(withId(discount, 'discount'), '2026-10-08T10:09:01.000Z', '2026-10-08T10:09:02.000Z', true),
]

const life = (phase: RunLifecycleEvent['phase'], updatedAt: string, extra: Partial<RunLifecycleEvent> = {}): RunLifecycleEvent =>
  ({ phase, headline: phase, updatedAt, ...extra })

export const evidenceLifecycleEvents: RunLifecycleEvent[] = [
  life('running-tests', '2026-10-08T10:00:00.000Z'),
  life('failed', '2026-10-08T10:00:11.000Z'),
  life('agent-healing', '2026-10-08T10:01:00.000Z', { activeCycle: 1, detail: 'Failures: test-case-applies-the-discount,test-case-reserves-stock' }),
  life('rerunning-tests', '2026-10-08T10:05:00.000Z', { targetedRerun: { selected: 2, total: 4, mode: 'failed-only', reason: 'failed tests' } }),
  life('failed', '2026-10-08T10:05:05.000Z'),
  life('agent-healing', '2026-10-08T10:06:00.000Z', { activeCycle: 2, detail: 'Failures: test-case-applies-the-discount' }),
  life('rerunning-tests', '2026-10-08T10:09:00.000Z', { targetedRerun: { selected: 1, total: 4, mode: 'failed-only', reason: 'failed tests' } }),
  life('completed', '2026-10-08T10:09:03.000Z'),
]

// `diagnosis-journal.md` as `appendJournalIteration` writes it. Entries carry
// the cycle's input failures by summary NAME — the two "loads the page" cases
// would be indistinguishable here — and no test id, execution or cycle number
// beyond the iteration counter.
export const evidenceJournalMarkdown = [
  '## Iteration 1 — 2026-10-08T10:04:30.000Z',
  '',
  '- run: run-evidence',
  '- feature: storefront',
  '- failingTests: test-case-applies-the-discount, test-case-reserves-stock',
  '- hypothesis: discount rounding happens before tax and stock reservation ignores holds',
  '- fix.file: src/pricing.ts, src/stock.ts',
  '- signal: .rerun',
  '- outcome: partial',
  '',
  '### Diff',
  '',
  '```diff',
  '--- a/src/pricing.ts',
  '+++ b/src/pricing.ts',
  '@@ -1 +1 @@',
  '-export const total = (p: number) => Math.round(p)',
  '+export const total = (p: number) => Math.round(p * 0.95)',
  '```',
  '',
  '## Iteration 2 — 2026-10-08T10:08:30.000Z',
  '',
  '- run: run-evidence',
  '- feature: storefront',
  '- failingTests: test-case-applies-the-discount',
  '- hypothesis: the discount is 10 percent, not 5',
  '- fix.file: src/pricing.ts',
  '- signal: .rerun',
  '- outcome: all_tests_passed',
  '',
].join('\n')

// The same run as a current build records it: each test-begin/test-end
// carries its execution, and the lifecycle records that open and close an
// execution (and start a repair cycle) carry their run-wide numbers.
const executionOfBegin = [1, 1, 1, 1, 1, 2, 2, 3]

export function stampedEvidencePlaybackEvents(): PlaywrightPlaybackEvent[] {
  let begin = -1
  return evidencePlaybackEvents.map((event) => {
    if (event.type === 'test-begin') begin += 1
    return event.type === 'test-begin' || event.type === 'test-end' ? { ...event, execution: executionOfBegin[begin] } : event
  })
}

export function stampedEvidenceLifecycleEvents(): RunLifecycleEvent[] {
  let execution = 0
  let cycle = 0
  return evidenceLifecycleEvents.map((event) => {
    if (event.phase === 'running-tests' || event.phase === 'rerunning-tests') execution += 1
    if (event.phase === 'agent-healing') cycle += 1
    if (event.phase === 'agent-healing') return { ...event, repairCycle: cycle }
    return { ...event, execution: { index: execution, afterCycle: cycle } }
  })
}
