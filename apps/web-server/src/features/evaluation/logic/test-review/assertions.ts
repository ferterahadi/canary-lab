import ts from 'typescript'
import { calledIdentifier, isAssertionCall, isWaitAssertionCall, matcherName } from './ast'
import { qualityLabel } from './html'
import { cleanSnippet } from './text'
import { AssertionQuality, HelperDefinition, NOT_RUN_STATUS, TestReviewAssertion } from './types'

export function missingAssertionReason(status: string, hasSource: boolean): string {
  if (status === NOT_RUN_STATUS) return 'This test was never executed, so the run produced no evidence for it.'
  if (hasSource) return 'No static assertion detected in the matched test body.'
  if (status === 'passed') return 'No playback event or source match was available for this passed test.'
  return 'No source match was available for this test.'
}

export function collectDirectAssertions(body: ts.Node, src: ts.SourceFile): TestReviewAssertion[] {
  const assertions: TestReviewAssertion[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && (isAssertionCall(node) || isWaitAssertionCall(node))) assertions.push(assertionFor(node, src, 'direct'))
    node.forEachChild(visit)
  }
  visit(body)
  return dedupeAssertions(assertions)
}

export function helperAssertion(
  node: ts.CallExpression,
  src: ts.SourceFile,
  helper: HelperDefinition | undefined,
): TestReviewAssertion {
  const label = calledIdentifier(node)!
  const nested = helper?.assertions ?? []
  const quality = nested.length ? strongestQuality(nested) : 'unknown'
  return {
    kind: 'helper',
    label,
    quality,
    rationale: nested.length
      ? `Helper resolves to ${nested.length} nested assertion${nested.length === 1 ? '' : 's'}; label reflects the strongest nested check.`
      : 'Helper implementation could not be resolved statically, so strictness is unknown.',
    snippet: cleanSnippet(node.getText(src)),
    helperName: label,
    ...(helper?.snippet ? { helperSnippet: helper.snippet } : {}),
    ...(nested.length ? { nested } : {}),
  }
}

export function assertionFor(
  node: ts.CallExpression,
  src: ts.SourceFile,
  kind: TestReviewAssertion['kind'],
): TestReviewAssertion {
  const snippet = cleanSnippet(node.getText(src))
  const matcher = matcherName(node)
  const quality = classifyAssertion(snippet, matcher)
  return {
    kind,
    label: matcher!,
    quality,
    rationale: rationaleFor(quality, snippet, matcher),
    snippet,
  }
}

// AssertionQuality measures the SPECIFICITY of a check — how exact a value it
// pins (exact value/text/URL → strict; a UI condition → moderate; mere existence
// → shallow). It is orthogonal to coverage's per-test STRENGTH (which stack layer
// the test reaches): a check can be deep-but-vague or shallow-but-exact.
export function classifyAssertion(snippet: string, matcher?: string): AssertionQuality {
  const text = snippet.toLowerCase()
  const m = matcher?.toLowerCase()
  // A bare boolean/nullish `toBe` (toBe(true), toBe(null)) pins almost nothing —
  // it reads as "exact" by matcher but proves little, so don't over-credit it.
  if (m === 'tobe' && /\.tobe\(\s*(true|false|null|undefined)\s*\)/.test(text)) return 'moderate'
  // Specificity is read from the MATCHER (structural), not from domain keywords —
  // no hardcoded business vocabulary, so it generalizes across every feature.
  // STRICT — pins a concrete expected value, text, URL, count, or object/array
  // shape: the check proves a specific outcome.
  const exactMatchers = new Set([
    'tohavetext',
    'tocontaintext',
    'tohaveurl',
    'tohavevalue',
    'tohaveattribute',
    'tohavecount',
    'tohavelength',
    'tobechecked',
    'tobedisabled',
    'tobeenabled',
    'waitforurl',
    'toequal',
    'tostrictequal',
    'tobe',
    'tomatchobject',
    'tomatch',
    'tocontain',
    'tocontainequal',
    'tohaveproperty',
    'tobecloseto',
  ])
  if (m && exactMatchers.has(m)) return 'strict'
  // MODERATE — a meaningful condition, but the evidence is indirect: visibility
  // or a thrown error.
  const behavioralMatchers = new Set([
    'tobevisible',
    'tobehidden',
    'tobeattached',
    'tothrow',
    'tothrowerror',
  ])
  if (m && behavioralMatchers.has(m)) return 'moderate'
  if (/visible|hidden|attached|enabled|disabled/.test(text)) return 'moderate'
  // SHALLOW — weak existence / truthiness / quantity evidence that doesn't pin the
  // business outcome (incl. numeric bounds, which only prove a quantity threshold).
  const shallowMatchers = new Set([
    'tobetruthy',
    'tobefalsy',
    'tobenull',
    'tobeundefined',
    'tobedefined',
    'tobenan',
    'tobegreaterthan',
    'tobegreaterthanorequal',
    'tobelessthan',
    'tobelessthanorequal',
  ])
  if (m && shallowMatchers.has(m)) return 'shallow'
  if (/count|length|exist|present/.test(text)) return 'shallow'
  // UNKNOWN is a true last resort — an unrecognized matcher we won't misgrade.
  return 'unknown'
}

export function rationaleFor(quality: AssertionQuality, snippet: string, matcher?: string): string {
  if (quality === 'strict') {
    return `Uses ${matcher} against concrete expected behavior or copy.`
  }
  if (quality === 'moderate') return 'Checks a meaningful condition, but the static evidence is indirect.'
  if (quality === 'shallow') return 'Checks weak existence or quantity evidence without proving the business outcome.'
  return 'Static analysis could not confidently classify this assertion.'
}

export function confidenceForAssertions(assertions: TestReviewAssertion[]): string {
  const summary = qualitySummaryForAudience(assertions)
  if (assertions.some((assertion) => assertion.quality === 'strict')) {
    return `Confidence: ${summary}. At least one check confirms an exact expected value or behavior.`
  }
  if (assertions.some((assertion) => assertion.quality === 'moderate')) {
    return `Confidence: ${summary}. The checks cover meaningful behavior, but some evidence is indirect.`
  }
  return `Confidence: ${summary}. Review the engineering evidence before relying on this scenario as strong proof.`
}

export function dedupeAssertions(assertions: TestReviewAssertion[]): TestReviewAssertion[] {
  const seen = new Set<string>()
  return assertions.filter((assertion) => {
    const key = `${assertion.kind}:${assertion.snippet}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function strongestQuality(assertions: TestReviewAssertion[]): AssertionQuality {
  const rank: Record<AssertionQuality, number> = { unknown: 0, shallow: 1, moderate: 2, strict: 3 }
  return assertions.reduce<AssertionQuality>((best, assertion) =>
    rank[assertion.quality] > rank[best] ? assertion.quality : best, 'unknown')
}

export function qualitySummary(assertions: TestReviewAssertion[]): string {
  const counts = new Map<AssertionQuality, number>()
  for (const assertion of assertions) counts.set(assertion.quality, (counts.get(assertion.quality) ?? 0) + 1)
  return (['strict', 'moderate', 'shallow', 'unknown'] as const)
    .flatMap((quality) => counts.has(quality) ? [`${counts.get(quality)} ${quality}`] : [])
    .join(', ')
}

export function qualitySummaryForAudience(assertions: TestReviewAssertion[]): string {
  const counts = new Map<AssertionQuality, number>()
  for (const assertion of assertions) counts.set(assertion.quality, (counts.get(assertion.quality) ?? 0) + 1)
  return (['strict', 'moderate', 'shallow', 'unknown'] as const)
    .flatMap((quality) => counts.has(quality) ? [`${counts.get(quality)} ${qualityLabel(quality)}`] : [])
    .join(', ')
}

export function unknownAssertion(rationale: string): TestReviewAssertion {
  return {
    kind: 'direct',
    label: 'unknown',
    quality: 'unknown',
    rationale,
    snippet: '',
  }
}

export function isNoiseHelper(name: string): boolean {
  return ['test', 'describe', 'beforeEach', 'afterEach'].includes(name)
}
