import path from 'path'
import type { RunDetail } from '../../../runs/logic/run-store'
import { loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import { confidenceForAssertions, qualitySummaryForAudience } from './assertions'
import { audienceFlowDetail, audienceFlowTitle, audienceTitle } from './audience'
import { flowNodesForTest } from './flowchart'
import { legacyCaseOrder, playbackTests, rosterKey, testStatusCounts } from './packet'
import { EVALUATION_REWRITE_TEMPLATE_PATH } from './rewrite-agent'
import { titleCaseFeatureName } from './text'
import { AssertionHtmlOptions, EvaluationLlmPromptInput, EvaluationRewrite, EvaluationRewriteCase, EvaluationTextSlot, NOT_RUN_STATUS, TestReviewPacket } from './types'

export function resolveRewrite(detail: RunDetail, packet: TestReviewPacket, options: AssertionHtmlOptions): EvaluationRewrite {
  const supplied = options.rewrite ?? options.narrative
  const widened = widenRewriteToRoster(supplied, detail, packet)
  return normalizeEvaluationRewrite(widened, packet) ?? deterministicEvaluationRewrite(packet)
}

/** Rewrites stored before the report listed never-run tests have one case per
 *  EXECUTED test, so they no longer line up with the full roster and would be
 *  rejected wholesale — every past export would lose its authored wording.
 *
 *  The old case order is not a guess: it was `playbackTests(events)` followed by
 *  summary-only passes, all of which are still on disk, so it can be rebuilt
 *  exactly and each case re-attached to the test it was written about. Cases with
 *  no counterpart (the never-run ones) take deterministic wording.
 *
 *  The run-level `summary` is NOT carried over — the stored one describes a
 *  6-scenario report ("of the six scenarios shown here…") and would misstate a
 *  23-test one. It is recomputed from the evidence instead. */
export function widenRewriteToRoster(
  input: EvaluationRewrite | undefined,
  detail: RunDetail,
  packet: TestReviewPacket,
): EvaluationRewrite | undefined {
  if (!input || !Array.isArray(input.cases)) return input
  if (input.cases.length === packet.tests.length) return input
  const legacy = legacyCaseOrder(detail)
  if (legacy.length !== input.cases.length) return input
  const caseByKey = new Map(legacy.map((key, idx) => [key, input.cases[idx]]))
  const fallback = deterministicEvaluationRewrite(packet)
  const featureTitle = typeof input.featureTitle === 'string' ? input.featureTitle : undefined
  return {
    ...(featureTitle ? { featureTitle } : {}),
    summary: deterministicSummary(packet, featureTitle?.trim() || titleCaseFeatureName(packet.feature)),
    cases: packet.tests.map((test, idx) => caseByKey.get(rosterKey(test)) ?? fallback.cases[idx]),
  }
}

export function buildEvaluationLlmPrompt(input: EvaluationLlmPromptInput): string {
  const evidence = {
    feature: input.packet.feature,
    status: input.packet.status,
    result: {
      total: input.packet.total,
      passed: input.packet.passed,
      failed: input.packet.failed,
      // Per-test breakdown so the narrative can't describe an abandoned suite as
      // a completed one. `notRun` tests were declared but never executed.
      breakdown: testStatusCounts(input.packet.tests),
    },
    tests: input.packet.tests.map((test) => ({
      title: test.title,
      status: test.status,
      checkStrength: qualitySummaryForAudience(test.assertions),
      flowSteps: input.flowcharts.find((flowchart) => flowchart.testName === test.name)?.steps ?? [],
      failureMessages: test.status === 'passed' ? [] : test.assertions.map((assertion) => assertion.rationale),
    })),
  }
  return renderPromptTemplate(loadPromptTemplate(input.templatePath ?? EVALUATION_REWRITE_TEMPLATE_PATH), {
    evidence: JSON.stringify(evidence, null, 2),
    textSlots: JSON.stringify(input.textSlots ?? evaluationTextSlots(deterministicEvaluationRewrite(input.packet)), null, 2),
    sourceHtmlSection: input.sourceHtml
      ? `Current generated HTML to rewrite from. Use this only as source wording/layout context; do not return HTML:\n${input.sourceHtml}`
      : '',
  })
}

export function evaluationTextSlots(rewrite: EvaluationRewrite): EvaluationTextSlot[] {
  return [
    ...(rewrite.featureTitle ? [{ id: 'featureTitle', text: rewrite.featureTitle }] : []),
    { id: 'summary', text: rewrite.summary },
    ...rewrite.cases.flatMap((test, idx) => [
      { id: `cases.${idx}.title`, text: test.title },
      { id: `cases.${idx}.whatWasChecked`, text: test.whatWasChecked },
      { id: `cases.${idx}.whyItMatters`, text: test.whyItMatters },
      { id: `cases.${idx}.confidence`, text: test.confidence },
      ...(test.flowSteps ?? []).flatMap((step, stepIdx) => [
        { id: `cases.${idx}.flowSteps.${stepIdx}.title`, text: step.title },
        ...(step.detail ? [{ id: `cases.${idx}.flowSteps.${stepIdx}.detail`, text: step.detail }] : []),
      ]),
    ]),
  ]
}

export function applyEvaluationTextSlotRewrite(base: EvaluationRewrite, slots: EvaluationTextSlot[]): EvaluationRewrite {
  const byId = new Map<string, string>()
  for (const slot of slots) {
    const text = slot.text.trim()
    if (text) byId.set(slot.id, text)
  }
  return {
    ...base,
    featureTitle: byId.get('featureTitle') ?? base.featureTitle,
    summary: byId.get('summary') ?? base.summary,
    cases: base.cases.map((test, idx) => ({
      ...test,
      title: byId.get(`cases.${idx}.title`) ?? test.title,
      whatWasChecked: byId.get(`cases.${idx}.whatWasChecked`) ?? test.whatWasChecked,
      whyItMatters: byId.get(`cases.${idx}.whyItMatters`) ?? test.whyItMatters,
      confidence: byId.get(`cases.${idx}.confidence`) ?? test.confidence,
      flowSteps: test.flowSteps?.map((step, stepIdx) => ({
        title: byId.get(`cases.${idx}.flowSteps.${stepIdx}.title`) ?? step.title,
        ...(step.detail || byId.has(`cases.${idx}.flowSteps.${stepIdx}.detail`)
          ? { detail: byId.get(`cases.${idx}.flowSteps.${stepIdx}.detail`) ?? step.detail }
          : {}),
      })),
    })),
  }
}

/** Run-level wording computed from the evidence. Takes the display name so a
 *  report that kept an authored feature title doesn't open with the raw slug. */
export function deterministicSummary(packet: TestReviewPacket, feature: string): string {
  const result = `${packet.passed}/${packet.total} checks passed`
  const notRun = testStatusCounts(packet.tests).notRun
  // Never-run scenarios are the headline when they exist: a reader who only sees
  // the pass ratio would otherwise assume the rest of the suite was exercised.
  const unrun = notRun > 0 ? ` ${notRun} of the ${packet.tests.length} declared scenarios never ran, so they are neither passing nor failing evidence.` : ''
  return packet.failed > 0
    ? `${feature} was evaluated with ${packet.tests.length} scenarios. ${result}, so review the failed scenarios before treating this behavior as ready.${unrun}`
    : `${feature} was evaluated with ${packet.tests.length} scenarios. ${result}, so the tested behavior matched the expected outcomes for this run.${unrun}`
}

export function deterministicEvaluationRewrite(packet: TestReviewPacket): EvaluationRewrite {
  const feature = titleCaseFeatureName(packet.feature)
  return {
    featureTitle: feature,
    summary: deterministicSummary(packet, feature),
    cases: packet.tests.map((test) => {
      const title = audienceTitle(test.title)
      return {
        title,
        whatWasChecked: test.status === NOT_RUN_STATUS
          ? `This scenario would check whether "${title}" behaves as expected, but the run stopped before reaching it.`
          : `This scenario checks whether "${title}" behaves as expected.`,
        whyItMatters: whyItMattersFor(test.status),
        confidence: confidenceForAssertions(test.assertions),
        flowSteps: flowNodesForTest(test).map((node) => ({
          title: audienceFlowTitle(node, test),
          ...(node.detail ? { detail: audienceFlowDetail(node.detail) } : {}),
        })),
      }
    }),
  }
}

export function whyItMattersFor(status: string): string {
  if (status === 'passed') return 'This matters because it shows the covered user or business path worked during this run.'
  if (status === NOT_RUN_STATUS) return 'This matters because the behavior it covers is still unverified — the run produced no result for it either way.'
  return 'This matters because a failed scenario may point to behavior that users or operations teams could experience.'
}

export function normalizeEvaluationRewrite(input: EvaluationRewrite | undefined, packet: TestReviewPacket): EvaluationRewrite | null {
  if (!input || typeof input.summary !== 'string' || !Array.isArray(input.cases)) return null
  if (input.cases.length !== packet.tests.length) return null
  const cases = input.cases.map((item) => {
    if (
      !item
      || typeof item.title !== 'string'
      || typeof item.whatWasChecked !== 'string'
      || typeof item.whyItMatters !== 'string'
      || typeof item.confidence !== 'string'
    ) {
      return null
    }
    return {
      title: item.title,
      whatWasChecked: item.whatWasChecked,
      whyItMatters: item.whyItMatters,
      confidence: item.confidence,
      ...(Array.isArray(item.flowSteps)
        ? {
            flowSteps: item.flowSteps
              .filter((step) => step && typeof step.title === 'string')
              .map((step) => ({
                title: step.title,
                ...(typeof step.detail === 'string' ? { detail: step.detail } : {}),
              })),
          }
        : {}),
    }
  })
  if (cases.some((item) => item === null)) return null
  return {
    ...(typeof input.featureTitle === 'string' ? { featureTitle: input.featureTitle } : {}),
    summary: input.summary,
    cases: cases as EvaluationRewriteCase[],
  }
}
