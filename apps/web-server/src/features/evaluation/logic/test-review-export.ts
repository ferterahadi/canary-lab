import type { RunDetail } from '../../../../../../shared/run-detail'
import { renderPromptTemplate } from '../../../shared/prompts'
import { classifyAssertion, confidenceForAssertions, qualitySummary, qualitySummaryForAudience } from './test-review/assertions'
import { functionLikeBody } from './test-review/ast'
import { audienceFlowDetail, audienceFlowTitle, audienceTitle, readableAction } from './test-review/audience'
import {
  actionFromIdentifier,
  readableActionName,
  readableCreatedObject,
} from '../../../shared/readable-tests/language'
import { applyFlowStepRewrite, createFlowcharts, flowNodesForTest } from './test-review/flowchart'
import { resultColor, wrapSvgText } from './test-review/flowchart-svg'
import { addCodeLineMarkers, qualityLabel, rationaleForAudience, renderAssertionHtml, renderFlowchartSection, renderHtml } from './test-review/html'
import { buildTestReviewPacket } from './test-review/packet'
import { applyEvaluationTextSlotRewrite, evaluationTextSlots, normalizeEvaluationRewrite, resolveRewrite } from './test-review/rewrite'
import { evaluationAgentModel, parseEvaluationRewrite, parseEvaluationTextSlotRewrite, previewAgentOutput } from './test-review/rewrite-agent'
import { formatMs, safeFilename, statusClass, uniqueSectionIds } from './test-review/text'
import { readableHelperName } from '../../../shared/readable-tests/language'
import type { AssertionExport, AssertionHtmlOptions } from './test-review/types'

export async function createAssertionHtml(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<string> {
  return createEvaluationHtml(detail, options)
}

export async function createEvaluationHtml(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<string> {
  const packet = buildTestReviewPacket(detail)
  const rewrite = resolveRewrite(detail, packet, options)
  const flowcharts = createFlowcharts(packet, rewrite)
  return renderHtml(packet, options, rewrite, flowcharts)
}

export async function createAssertionExport(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<AssertionExport> {
  return createEvaluationExport(detail, options)
}

export async function createEvaluationExport(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<AssertionExport> {
  const packet = buildTestReviewPacket(detail)
  const rewrite = resolveRewrite(detail, packet, options)
  const flowcharts = createFlowcharts(packet, rewrite)
  return {
    html: await renderHtml(packet, options, rewrite, flowcharts),
    assets: [],
  }
}

export const __testReviewExportInternals = {
  actionFromIdentifier,
  addCodeLineMarkers,
  applyFlowStepRewrite,
  audienceFlowDetail,
  audienceFlowTitle,
  audienceTitle,
  classifyAssertion,
  confidenceForAssertions,
  evaluationAgentModel,
  evaluationTextSlots,
  formatMs,
  flowNodesForTest,
  functionLikeBody,
  normalizeEvaluationRewrite,
  applyEvaluationTextSlotRewrite,
  parseEvaluationRewrite,
  parseEvaluationTextSlotRewrite,
  previewAgentOutput,
  qualityLabel,
  qualitySummary,
  qualitySummaryForAudience,
  rationaleForAudience,
  renderPromptTemplate,
  renderAssertionHtml,
  renderFlowchartSection,
  readableAction,
  readableActionName,
  readableCreatedObject,
  readableHelperName,
  resultColor,
  safeFilename,
  statusClass,
  uniqueSectionIds,
  wrapSvgText,
}
