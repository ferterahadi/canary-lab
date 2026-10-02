import { expect, it } from 'vitest'
import { sourceCacheKey, sourceIdentityKey, type AgentSessionIdentity } from './agent-session-source'

const sources: [AgentSessionIdentity, string][] = [
  [{ kind: 'discovery-repair', taskId: 'repair/1' }, 'discovery-repair:repair/1'],
  [{ kind: 'run', runId: 'run/1' }, 'run:run/1'],
  [{ kind: 'benchmark', benchmarkId: 'bench/1' }, 'benchmark:bench/1'],
  [{ kind: 'portify', workflowId: 'portify/1' }, 'portify:portify/1'],
  [{ kind: 'coverage', jobId: 'job/1' }, 'coverage:job/1'],
  [{ kind: 'evaluation', taskId: 'eval/1' }, 'evaluation:eval/1'],
  [{ kind: 'flight', flightId: 'flight/1', stage: 'specs:2' }, 'flight:flight/1:specs:2'],
  [{ kind: 'flight-plan', taskId: 'plan/1' }, 'flight-plan:plan/1'],
]

it.each(sources)('preserves the identity and live/history cache keys for %j', (source, identity) => {
  expect(sourceIdentityKey(source)).toBe(identity)
  expect(sourceCacheKey(source)).toBe(`${identity}:0`)
  expect(sourceCacheKey({ ...source, live: false })).toBe(`${identity}:0`)
  expect(sourceCacheKey({ ...source, live: true })).toBe(`${identity}:1`)
})

it('keeps stages of the same flight separate', () => {
  expect(sourceIdentityKey({ kind: 'flight', flightId: 'f1', stage: 'docs' }))
    .not.toBe(sourceIdentityKey({ kind: 'flight', flightId: 'f1', stage: 'specs' }))
})
