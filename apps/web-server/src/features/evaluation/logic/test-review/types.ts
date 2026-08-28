import { type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'

export type AssertionQuality = 'strict' | 'moderate' | 'shallow' | 'unknown'

export interface TestReviewAssertion {
  kind: 'direct' | 'helper'
  label: string
  quality: AssertionQuality
  rationale: string
  snippet: string
  helperName?: string
  helperSnippet?: string
  nested?: TestReviewAssertion[]
}

export interface TestReviewCase {
  name: string
  title: string
  status: string
  durationMs?: number
  testBody: string
  helperCalls: string[]
  helperDefinitions: HelperDefinition[]
  externalImports: string[]
  assertions: TestReviewAssertion[]
  /** `file:line` the test is declared at, when the roster or playback knows it.
   *  Drives the per-spec-file grouping in the report's navigation. */
  location?: string
  /** Playwright's own failure message + code frame, when the run reported one.
   *  A report about failures that hides the reason isn't evidence. */
  error?: { message: string; snippet?: string }
}

/** Status carried by a declared test the run never reached. Deliberately NOT
 *  'skipped' (Playwright reached it and chose to skip) and never folded into
 *  passed or failed — a never-run test is neither, and the report has to say so.
 *  See the `cl_run-evidence-invariants` skill, "Honest counts". */
export const NOT_RUN_STATUS = 'not run'

export interface TestReviewPacket {
  runId: string
  feature: string
  status: string
  total: number
  passed: number
  failed: number
  startedAt: string
  endedAt?: string
  tests: TestReviewCase[]
}

export interface AssertionHtmlOptions {
  videoLinksByTestName?: Record<string, string[]>
  audienceAdapter?: 'auto' | 'claude' | 'codex' | 'manual' | 'deterministic'
  rewrite?: EvaluationRewrite
  narrative?: EvaluationRewrite
  /** Semantic coverage ledger for the feature, when one exists. Present → the
   *  report leads with per-requirement coverage + per-test STRENGTH; absent →
   *  falls back to the Playwright assertion-specificity grading. */
  coverage?: CoverageLedger
}

export interface EvaluationRewriteAgentOptions {
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
  /** Fired once the rewrite agent is spawned, with the pinned session ref so
   *  the caller can persist it and stream the agent's JSONL via AgentSessionView
   *  (claude: a pinned --session-id UUID; codex: '' — located by cwd + start). */
  onSession?: (session: { agent: HealAgent; sessionId: string }) => void
}

export interface EvaluationRewriteFlowStep {
  title: string
  detail?: string
}

export interface EvaluationRewriteCase {
  title: string
  whatWasChecked: string
  whyItMatters: string
  confidence: string
  flowSteps?: EvaluationRewriteFlowStep[]
}

export interface EvaluationRewrite {
  formatVersion?: number
  featureTitle?: string
  summary: string
  cases: EvaluationRewriteCase[]
}

export interface EvaluationTextSlot {
  id: string
  text: string
  locked?: boolean
}

export interface AssertionExportAsset {
  filename: string
  data: Buffer
}

export interface AssertionExport {
  html: string
  assets: AssertionExportAsset[]
}

export interface EvaluationLlmPromptInput {
  packet: TestReviewPacket
  flowcharts: Array<{ testName: string; steps: string[] }>
  sourceHtml?: string
  textSlots?: EvaluationTextSlot[]
  templatePath?: string
}

export interface TestFlowchart {
  testName: string
  svg: string
  steps: FlowNode[]
}

export interface FlowNode {
  kind: 'start' | 'setup' | 'action' | 'helper' | 'assertion' | 'end'
  title: string
  detail?: string
  codeLine?: number
  /** The title already came from the canonical readable-test translator. */
  readable?: true
}

export interface SourceTest {
  file: string
  line: number
  title: string
  bodySource: string
  helperCalls: string[]
  helperDefinitions: HelperDefinition[]
  externalImports: string[]
  assertions: TestReviewAssertion[]
}

export interface ImportedHelper {
  name: string
  file: string
}

export interface HelperDefinition {
  name: string
  file: string
  snippet: string
  bodySource?: string
  startLine?: number
  externalImports: string[]
  dependencies: HelperDefinition[]
  assertions: TestReviewAssertion[]
}

export interface RosterEntry {
  id?: string
  name: string
  title: string
  location?: string
}

export interface RunVerdicts {
  passedIds: Set<string>
  passedNames: Set<string>
  skippedIds: Set<string>
  skippedNames: Set<string>
  failedIds: Set<string>
  failedNames: Set<string>
  errorByName: Map<string, { message: string; snippet?: string }>
}

export interface TestStatusCounts {
  passed: number
  failed: number
  interrupted: number
  skipped: number
  notRun: number
}

export interface NavItem {
  index: number
  id: string
  label: string
  status: keyof TestStatusCounts
  rawTitle: string
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}
