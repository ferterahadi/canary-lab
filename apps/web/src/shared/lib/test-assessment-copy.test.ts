import { expect, it } from 'vitest'
import type { PredicateChange } from '@shared/verification-strength/types'
import { noTestAssessmentCopy, testAssessmentFinding, testAssessmentReason } from './test-assessment-copy'

it('keeps each finding and its consequence together in plain language', () => {
  const changes: PredicateChange[] = [
    { kind: 'retargeted', verdict: 'equivalent' },
    { kind: 'removed', verdict: 'weaker' },
    { kind: 'added', verdict: 'stronger' },
    { kind: 'reshaped', verdict: 'weaker' },
    { kind: 'reshaped', verdict: 'stronger' },
    { kind: 'reshaped', verdict: 'unclassifiable' },
    { kind: 'unreadable', verdict: 'unclassifiable' },
    { kind: 'guarded', verdict: 'weaker' },
    { kind: 'unguarded', verdict: 'stronger' },
  ]
  expect(changes.map(testAssessmentFinding)).toEqual([
    'The check now targets something different. It is just as specific, but it may be checking a different thing.',
    'A check was removed. The test may now miss a problem it used to catch.',
    'A new check was added. The test can now catch an additional problem.',
    'The check was made less specific. The test may now miss a problem it used to catch.',
    'The check was made more specific. The test can now catch a problem it could miss before.',
    'The check changed, but Canary Lab cannot tell whether it catches more or fewer problems.',
    'A changed check could not be read, so Canary Lab cannot tell what changed.',
    'A condition can now stop this test from running. When it does, this test will not catch problems.',
    'A condition that could stop this test was removed. This test will run in more situations.',
  ])
})

it('translates every generated reason and preserves an unfamiliar reason', () => {
  expect(testAssessmentReason('unknown matcher toBeCustom')).toBe('Canary Lab does not recognize the toBeCustom check.')
  expect(testAssessmentReason('before side does not parse: Unexpected token')).toBe('The earlier version could not be read: Unexpected token')
  expect(testAssessmentReason('after side does not parse: Unexpected token')).toBe('The current version could not be read: Unexpected token')
  expect(testAssessmentReason('expected value is computed at run time')).toBe('The expected value is calculated when the test runs.')
  expect(testAssessmentReason('value matcher without a value')).toBe('This check is missing its expected value.')
  expect(testAssessmentReason('polarity flipped')).toBe('The check was reversed.')
  expect(testAssessmentReason('matcher changed at equal strength')).toBe('The type of check changed, but neither version is clearly stricter.')
  expect(testAssessmentReason('expected value changed at equal strength')).toBe('The expected value changed, but neither version is clearly stricter.')
  expect(testAssessmentReason('an assertion the collector cannot read was removed')).toBe('A check was removed, but Canary Lab cannot read it.')
  expect(testAssessmentReason('an assertion the collector cannot read was added')).toBe('A check was added, but Canary Lab cannot read it.')
  expect(testAssessmentReason('test.only limits the run to 1 of 4 tests')).toBe('Test scope is narrower: only 1 of 4 tests will run.')
  expect(testAssessmentReason('test.only removed; all 4 tests run again')).toBe('Test scope is restored: all tests will run again.')
  expect(testAssessmentReason('new reason from the analyser')).toBe('new reason from the analyser')
  expect(testAssessmentFinding({ kind: 'reshaped', verdict: 'unclassifiable', reason: 'expected value is computed at run time' })).toBe(
    'Canary Lab cannot tell whether this check catches more or fewer problems. The expected value is calculated when the test runs.',
  )
})

it('explains an unassessed edit and both unchanged baselines', () => {
  expect(noTestAssessmentCopy(1)).toBe('This edit does not change a test check Canary Lab can assess.')
  expect(noTestAssessmentCopy(0)).toBe('No differences from Git HEAD.')
  expect(noTestAssessmentCopy(0, 'run-1')).toBe('No differences from the recorded test version.')
})
