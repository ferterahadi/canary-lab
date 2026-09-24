import type { PredicateChange } from '@shared/verification-strength/types'

/** UI wording for the comparison result. The differential remains the source of
 * truth; this only turns its implementation terms into language a reader can act on. */
export function testAssessmentFinding(change: PredicateChange): string {
  if (change.reason) return `Canary Lab cannot tell whether this check catches more or fewer problems. ${testAssessmentReason(change.reason)}`

  switch (change.kind) {
    case 'removed':
      return 'A check was removed. The test may now miss a problem it used to catch.'
    case 'added':
      return 'A new check was added. The test can now catch an additional problem.'
    case 'retargeted':
      return 'The check now targets something different. It is just as specific, but it may be checking a different thing.'
    case 'reshaped':
      return change.verdict === 'weaker'
        ? 'The check was made less specific. The test may now miss a problem it used to catch.'
        : change.verdict === 'stronger'
          ? 'The check was made more specific. The test can now catch a problem it could miss before.'
          : 'The check changed, but Canary Lab cannot tell whether it catches more or fewer problems.'
    case 'unreadable':
      return 'A changed check could not be read, so Canary Lab cannot tell what changed.'
    case 'guarded':
      return 'A condition can now stop this test from running. When it does, this test will not catch problems.'
    case 'unguarded':
      return 'A condition that could stop this test was removed. This test will run in more situations.'
  }
}

export function testAssessmentReason(reason: string): string {
  const matcher = /^unknown matcher (.+)$/.exec(reason)
  if (matcher) return `Canary Lab does not recognize the ${matcher[1]} check.`

  const parseFailure = /^(before|after) side does not parse: (.+)$/.exec(reason)
  if (parseFailure) return `The ${parseFailure[1] === 'before' ? 'earlier' : 'current'} version could not be read: ${parseFailure[2]}`

  const copy: Record<string, string> = {
    'expected value is computed at run time': 'The expected value is calculated when the test runs.',
    'value matcher without a value': 'This check is missing its expected value.',
    'polarity flipped': 'The check was reversed.',
    'matcher changed at equal strength': 'The type of check changed, but neither version is clearly stricter.',
    'expected value changed at equal strength': 'The expected value changed, but neither version is clearly stricter.',
    'an assertion the collector cannot read was removed': 'A check was removed, but Canary Lab cannot read it.',
    'an assertion the collector cannot read was added': 'A check was added, but Canary Lab cannot read it.',
  }
  return copy[reason] ?? testOnlyReason(reason) ?? reason
}

function testOnlyReason(reason: string): string | undefined {
  const narrowed = /^test\.only limits the run to (\d+) of (\d+) tests$/.exec(reason)
  if (narrowed) return `Test scope is narrower: only ${narrowed[1]} of ${narrowed[2]} tests will run.`

  const restored = /^test\.only removed; all (\d+) tests run again$/.exec(reason)
  if (restored) return 'Test scope is restored: all tests will run again.'
  return undefined
}

export function noTestAssessmentCopy(changes: number, runId?: string): string {
  if (changes) return 'This edit does not change a test check Canary Lab can assess.'
  return runId ? 'No differences from the recorded test version.' : 'No differences from Git HEAD.'
}
