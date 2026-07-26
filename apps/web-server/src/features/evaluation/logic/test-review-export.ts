import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { codeToHtml } from 'shiki'
import ts from 'typescript'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../runs/logic/run-store'
import { pickAvailableHealAgent, type HealAgent } from '../../runs/logic/runtime/auto-heal'
import { EVALUATION_REWRITE_MODELS, modelArgs, modelFor } from '../../agent-sessions/logic/agent-models'
import { recoverAgentAnswer, agentActivityPath } from '../../agent-sessions/logic/agent-producer'
import { extractJsonCandidates } from '../../agent-sessions/logic/agent-json'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../agent-sessions/logic/agent-process'
import { formatCodeForDisplay } from '../../../../../../shared/code-display-format'
import type { CoverageLedger, TestCoverage, TestStrength } from '../../../../../../shared/coverage/types'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../shared/prompts'

export type AssertionQuality = 'strict' | 'moderate' | 'shallow' | 'unknown'

// Display labels for coverage's per-test STRENGTH (depth axis), used when a feature
// has a generated coverage ledger. Distinct vocabulary from AssertionQuality
// ("specificity" axis) so the report carries two non-competing signals.
const STRENGTH_LABEL: Record<TestStrength, string> = {
  strong: 'Strong',
  solid: 'Solid',
  basic: 'Basic',
  shallow: 'Shallow',
}

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

interface TestFlowchart {
  testName: string
  svg: string
  steps: FlowNode[]
}

interface FlowNode {
  kind: 'start' | 'setup' | 'action' | 'helper' | 'assertion' | 'end'
  title: string
  detail?: string
  codeLine?: number
}

interface SourceTest {
  file: string
  line: number
  title: string
  bodySource: string
  helperCalls: string[]
  helperDefinitions: HelperDefinition[]
  externalImports: string[]
  assertions: TestReviewAssertion[]
}

interface ImportedHelper {
  name: string
  file: string
}

export interface HelperDefinition {
  name: string
  file: string
  snippet: string
  externalImports: string[]
  dependencies: HelperDefinition[]
  assertions: TestReviewAssertion[]
}

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

function resolveRewrite(detail: RunDetail, packet: TestReviewPacket, options: AssertionHtmlOptions): EvaluationRewrite {
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
function widenRewriteToRoster(
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

/** The roster the report built before it enumerated declared tests: executed
 *  tests in playback order, then summary-only passes. */
function legacyCaseOrder(detail: RunDetail): string[] {
  const out = playbackTests(detail.playbackEvents ?? []).map(rosterKey)
  const titles = new Set(playbackTests(detail.playbackEvents ?? []).map((test) => test.title))
  for (const passedName of detail.summary?.passedNames ?? []) {
    if ([...titles].some((title) => slugFromTitle(title) === passedName || title === passedName)) continue
    titles.add(passedName)
    out.push(rosterKey({ name: passedName }))
  }
  return out
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

export async function generateEvaluationRewriteWithAgent(
  detail: RunDetail,
  adapter: AssertionHtmlOptions['audienceAdapter'],
  cwd?: string,
  options: EvaluationRewriteAgentOptions = {},
): Promise<EvaluationRewrite | null> {
  const agents = resolveEvaluationAgents(adapter)
  if (!agents.length) return null
  const packet = buildTestReviewPacket(detail)
  const fallback = deterministicEvaluationRewrite(packet)
  const flowcharts = createFlowcharts(packet, fallback)
  const textSlots = evaluationTextSlots(fallback)
  const prompt = buildEvaluationLlmPrompt({
    packet,
    textSlots,
    flowcharts: flowcharts.map((flowchart) => ({
      testName: flowchart.testName,
      steps: flowchart.steps.map((step) => step.detail ? `${step.title}: ${step.detail}` : step.title),
    })),
  })
  const failures: string[] = []
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]
    const nextAgent = agents[i + 1]
    const recordFailure = (reason: string) => {
      failures.push(`${agent}: ${reason}`)
      // Surface WHY this agent dropped out — otherwise the live log just shows
      // one agent start, then the next, with no explanation for the handoff.
      const handoff = nextAgent ? ` — falling back to ${nextAgent}` : ''
      options.onOutput?.(`[agent:${agent}] rewrite failed: ${reason}${handoff}\n`)
    }
    try {
      options.onOutput?.(`[agent:${agent}] starting localized rewrite (model: ${evaluationAgentModel(agent) ?? 'agent default'})\n`)
      const output = await runEvaluationAgent(agent, prompt, cwd, options.onOutput, options.signal, options.onSession)
      const slotRewrite = parseEvaluationTextSlotRewrite(output)
      if (slotRewrite) {
        options.onOutput?.(`[agent:${agent}] localized rewrite completed\n`)
        return applyEvaluationTextSlotRewrite(fallback, slotRewrite)
      }
      const parsed = parseEvaluationRewrite(output)
      const rewrite = normalizeEvaluationRewrite(parsed, packet)
      if (rewrite) {
        options.onOutput?.(`[agent:${agent}] localized rewrite completed\n`)
        return rewrite
      }
      recordFailure(`unparseable output: ${previewAgentOutput(output)}`)
    } catch (err) {
      recordFailure(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`evaluation rewrite failed with all available agents: ${failures.join(' | ')}`)
}

const EVALUATION_REWRITE_TEMPLATE_PATH = promptPath('evaluation-rewrite.md')
const EVALUATION_REWRITE_SCHEMA_PATH = promptPath('evaluation-rewrite.schema.json')

function resolveEvaluationAgents(adapter: AssertionHtmlOptions['audienceAdapter']): HealAgent[] {
  if (adapter === 'deterministic') return []
  const preferred = adapter === 'claude' || adapter === 'codex'
    ? pickAvailableHealAgent(adapter)
    : pickAvailableHealAgent()
  const agents = [
    preferred,
    pickAvailableHealAgent('claude'),
    pickAvailableHealAgent('codex'),
  ].filter((agent): agent is HealAgent => agent === 'claude' || agent === 'codex')
  return [...new Set(agents)]
}

function evaluationAgentModel(agent: HealAgent): string | null {
  return modelFor(EVALUATION_REWRITE_MODELS, agent)
}

// Idle (inactivity) window: the rewrite agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
const EVALUATION_IDLE_TIMEOUT_MS = 5 * 60 * 1000

function runEvaluationAgent(
  agent: HealAgent,
  prompt: string,
  cwd?: string,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
  onSession?: (session: { agent: HealAgent; sessionId: string }) => void,
): Promise<string> {
  const outputDir = agent === 'codex' ? fs.mkdtempSync(path.join(os.tmpdir(), 'canary-evaluation-rewrite-')) : undefined
  const outputPath = outputDir ? path.join(outputDir, 'last-message.txt') : undefined
  // Pin a session id for claude so the CLI's JSONL session log is locatable and
  // AgentSessionView can tail it (the live view comes from that JSONL, not stdout).
  // Codex has no --session-id; it's located later by cwd + start.
  const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  // Agentic spawn via the shared runner. claude: stream-json for liveness +
  // answer recovery (display is the JSONL tail); codex: `exec` reads the prompt
  // from stdin (`-`) and writes the final message to --output-last-message.
  const args = agent === 'claude'
    ? buildClaudeAgenticArgs(prompt, { model: EVALUATION_REWRITE_MODELS.claude, sessionId: claudeSessionId })
    : evaluationCodexArgs('-', outputPath, EVALUATION_REWRITE_SCHEMA_PATH)
  onSession?.(agent === 'claude' ? { agent: 'claude', sessionId: claudeSessionId! } : { agent: 'codex', sessionId: '' })

  let idled = false
  const handle = runAgentProcess({
    command: agent,
    args,
    cwd,
    stdin: agent === 'codex' ? prompt : undefined,
    onChunk: (text) => onOutput?.(text),
    idleMs: EVALUATION_IDLE_TIMEOUT_MS,
    activityPath: agentActivityPath(agent, cwd, claudeSessionId),
    onIdle: () => { idled = true },
    onTick: (idleMs) => {
      if (idleMs >= 10_000) onOutput?.(`[agent:${agent}] still running; waiting for CLI output (${Math.floor(idleMs / 1000)}s idle)\n`)
    },
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const rmOutputDir = (): void => { if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true }) }
    const settleErr = (err: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rmOutputDir()
      reject(err)
    }
    const settleOk = (output: string): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rmOutputDir()
      resolve(output)
    }
    // Abort rejects immediately (don't wait for the child to close) — the caller
    // races multiple agents and shouldn't block on a killed process draining.
    function onAbort(): void { handle.stop(); settleErr(new Error('evaluation rewrite cancelled')) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    handle.done.then(
      ({ code, signal: sig, stdout, stderr }) => {
        if (idled) { settleErr(new Error(`evaluation rewrite agent idle for ${EVALUATION_IDLE_TIMEOUT_MS}ms`)); return }
        if (code !== 0) {
          settleErr(new Error(`evaluation rewrite agent failed with ${sig ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`))
          return
        }
        // Read the codex output file BEFORE settleOk() removes the temp dir.
        let finalOutput = recoverAgentAnswer(agent, stdout)
        if (outputPath && fs.existsSync(outputPath)) {
          const fromFile = fs.readFileSync(outputPath, 'utf-8')
          if (fromFile.trim()) finalOutput = fromFile
        }
        settleOk(finalOutput)
      },
      (err: Error) => settleErr(new Error(`evaluation rewrite agent failed: ${err.message}`)),
    )
  })
}

export function evaluationCodexArgs(prompt: string, outputPath?: string, outputSchemaPath?: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    ...modelArgs(EVALUATION_REWRITE_MODELS.codex),
    ...(outputPath ? ['--output-last-message', outputPath] : []),
    ...(outputSchemaPath ? ['--output-schema', outputSchemaPath] : []),
    prompt,
  ]
}

function previewAgentOutput(output: string): string {
  const text = output.replace(/\s+/g, ' ').trim()
  if (!text) return '<empty output>'
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function parseEvaluationRewrite(output: string): EvaluationRewrite | undefined {
  // First candidate carrying a `cases` array — the rewrite envelope's anchor —
  // so brace-bearing prose around the answer can't shadow it.
  for (const c of extractJsonCandidates(output)) {
    if (c && typeof c === 'object' && Array.isArray((c as { cases?: unknown }).cases)) {
      return c as EvaluationRewrite
    }
  }
  return undefined
}

function parseEvaluationTextSlotRewrite(output: string): EvaluationTextSlot[] | undefined {
  for (const c of extractJsonCandidates(output)) {
    if (!c || typeof c !== 'object') continue
    const parsed = c as { slots?: unknown }
    if (!Array.isArray(parsed.slots)) continue
    const slots = parsed.slots.flatMap((slot): EvaluationTextSlot[] => {
      if (!slot || typeof slot !== 'object') return []
      const item = slot as Partial<EvaluationTextSlot>
      if (typeof item.id !== 'string' || typeof item.text !== 'string') return []
      return [{ id: item.id, text: item.text }]
    })
    return slots.length ? slots : undefined
  }
  return undefined
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

export function buildTestReviewPacket(detail: RunDetail): TestReviewPacket {
  const events = detail.playbackEvents ?? []
  const sourceTests = loadSourceTests(detail.manifest.featureDir)
  const eventTests = playbackTests(events)
  const verdicts = runVerdicts(detail)
  const eventByKey = new Map(eventTests.map((eventTest) => [rosterKey(eventTest), eventTest]))
  const tests = declaredRoster(detail, eventTests).map((entry) => {
    const eventTest = eventByKey.get(rosterKey(entry))
    const source = entry.location ? sourceTests.get(sourceKey(entry.location)) : undefined
    const status = eventTest?.status ?? summaryStatusFor(entry, verdicts)
    const error = verdicts.errorByName.get(entry.name) ?? eventTest?.error
    return {
      name: entry.name,
      title: entry.title,
      status,
      ...(typeof eventTest?.durationMs === 'number' ? { durationMs: eventTest.durationMs } : {}),
      ...(entry.location ? { location: entry.location } : {}),
      ...(error ? { error } : {}),
      testBody: source?.bodySource ?? '',
      helperCalls: source?.helperCalls ?? [],
      helperDefinitions: source?.helperDefinitions ?? [],
      externalImports: source?.externalImports ?? [],
      assertions: source?.assertions.length
        ? source.assertions
        : [unknownAssertion(missingAssertionReason(status, Boolean(source)))],
    }
  })

  return {
    runId: detail.runId,
    feature: detail.manifest.feature,
    status: detail.manifest.status,
    total: detail.summary?.total ?? tests.length,
    passed: detail.summary?.passed ?? tests.filter((test) => test.status === 'passed').length,
    failed: detail.summary?.failed?.length ?? tests.filter((test) => test.status !== 'passed').length,
    startedAt: detail.manifest.startedAt,
    ...(detail.manifest.endedAt ? { endedAt: detail.manifest.endedAt } : {}),
    tests,
  }
}

function missingAssertionReason(status: string, hasSource: boolean): string {
  if (status === NOT_RUN_STATUS) return 'This test was never executed, so the run produced no evidence for it.'
  if (hasSource) return 'No static assertion detected in the matched test body.'
  if (status === 'passed') return 'No playback event or source match was available for this passed test.'
  return 'No source match was available for this test.'
}

interface RosterEntry {
  id?: string
  name: string
  title: string
  location?: string
}

/** The tests the run DECLARED, not the ones it got around to executing.
 *
 *  `summary.knownTests` is the harness's own enumeration — Playwright's reporter
 *  walks the whole suite before the first test starts — so it still lists tests
 *  a run abandoned when it stopped at the failure limit. Building the roster from
 *  playback events instead (what this used to do) silently deleted those tests
 *  from the report, which is exactly the rounding-up the evidence rules forbid:
 *  a 23-test suite that stopped after 6 reported as a 6-test suite.
 *
 *  Runs recorded before the reporter emitted `knownTests` have none, so those
 *  fall back to the executed set — the old behavior, and still all the evidence
 *  that exists for them. */
function declaredRoster(detail: RunDetail, eventTests: ReturnType<typeof playbackTests>): RosterEntry[] {
  const out: RosterEntry[] = []
  const seen = new Set<string>()
  const add = (entry: RosterEntry): void => {
    const key = rosterKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    out.push(entry)
  }
  for (const known of detail.summary?.knownTests ?? []) {
    add({
      ...(known.id ? { id: known.id } : {}),
      name: known.name,
      title: known.title ?? known.name,
      ...(known.location ? { location: known.location } : {}),
    })
  }
  // Append rather than replace: anything the run actually reported that the
  // roster somehow misses is evidence, and evidence is never dropped.
  for (const eventTest of eventTests) add(eventTest)
  for (const passedName of detail.summary?.passedNames ?? []) {
    // Match on name first: a roster entry and a `passedNames` entry are the same
    // test when the names agree, even though the roster's title may carry
    // annotations that no longer slugify back to it.
    if (out.some((entry) => entry.name === passedName || slugFromTitle(entry.title) === passedName || entry.title === passedName)) continue
    add({ name: passedName, title: passedName })
  }
  return out
}

/** Name is `test-case-${slugify(title)}`, so two tests can share one only by
 *  sharing a title — the location disambiguates them. Matches `playbackTests`. */
function rosterKey(entry: { name: string; location?: string }): string {
  return `${entry.name}@${entry.location ? sourceKey(entry.location) : ''}`
}

interface RunVerdicts {
  passedIds: Set<string>
  passedNames: Set<string>
  skippedIds: Set<string>
  skippedNames: Set<string>
  failedIds: Set<string>
  failedNames: Set<string>
  errorByName: Map<string, { message: string; snippet?: string }>
}

function runVerdicts(detail: RunDetail): RunVerdicts {
  const failed = detail.summary?.failed ?? []
  const errorByName = new Map<string, { message: string; snippet?: string }>()
  for (const entry of failed) if (entry.error) errorByName.set(entry.name, entry.error)
  return {
    passedIds: new Set(detail.summary?.passedIds ?? []),
    passedNames: new Set(detail.summary?.passedNames ?? []),
    skippedIds: new Set(detail.summary?.skippedIds ?? []),
    skippedNames: new Set(detail.summary?.skippedNames ?? []),
    failedIds: new Set(failed.map((entry) => entry.id).filter((id): id is string => typeof id === 'string')),
    failedNames: new Set(failed.map((entry) => entry.name)),
    errorByName,
  }
}

/** Status for a roster entry with no playback event of its own. Failed and
 *  skipped are checked before passed so a name that somehow lands in two lists
 *  resolves downward — the report never rounds a test up into a pass. */
function summaryStatusFor(entry: RosterEntry, verdicts: RunVerdicts): string {
  if ((entry.id && verdicts.failedIds.has(entry.id)) || verdicts.failedNames.has(entry.name)) return 'failed'
  if ((entry.id && verdicts.skippedIds.has(entry.id)) || verdicts.skippedNames.has(entry.name)) return 'skipped'
  if ((entry.id && verdicts.passedIds.has(entry.id)) || verdicts.passedNames.has(entry.name)) return 'passed'
  return NOT_RUN_STATUS
}

export interface TestStatusCounts {
  passed: number
  failed: number
  interrupted: number
  skipped: number
  notRun: number
}

/** Per-test breakdown, derived from each test's own recorded verdict rather than
 *  from arithmetic on the totals. `summary.failed` lumps interrupted tests in with
 *  real failures, so this is the only place the two are told apart — and unlike
 *  `total - failed` it can never turn a never-run test into a pass. */
export function testStatusCounts(tests: TestReviewCase[]): TestStatusCounts {
  const counts: TestStatusCounts = { passed: 0, failed: 0, interrupted: 0, skipped: 0, notRun: 0 }
  for (const test of tests) counts[statusBucket(test.status)] += 1
  return counts
}

export function statusBucket(status: string): keyof TestStatusCounts {
  const normalized = status.toLowerCase()
  if (normalized === 'passed') return 'passed'
  if (normalized === 'skipped') return 'skipped'
  if (normalized === NOT_RUN_STATUS) return 'notRun'
  if (normalized === 'interrupted') return 'interrupted'
  return 'failed'
}

function loadSourceTests(featureDir: string | undefined): Map<string, SourceTest> {
  const out = new Map<string, SourceTest>()
  if (!featureDir || !fs.existsSync(featureDir)) return out
  for (const file of listSpecFiles(featureDir)) {
    const source = safeRead(file)
    if (source === null) continue
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const imports = readRelativeImports(file, src)
    const externalImports = readExternalImports(src)
    const helpers = new Map<string, HelperDefinition>()
    const helperFor = (name: string): HelperDefinition | undefined => {
      if (helpers.has(name)) return helpers.get(name)
      const imported = imports.get(name) ?? (hasLocalDefinition(src, name) ? { name, file } : undefined)
      if (!imported) return undefined
      const resolved = readHelperDefinition(imported, new Set([`${file}:${name}`]))
      if (resolved) helpers.set(name, resolved)
      return resolved
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && isPlaywrightTestCall(node)) {
        const title = stringArg(node, src)
        const body = functionBody(node)
        if (title && body) {
          const review = reviewTestBody(body, src, helperFor)
          out.set(`${file}:${lineFor(node, src)}`, {
            file,
            line: lineFor(node, src),
            title,
            bodySource: formatCodeForDisplay(body.getText(src)),
            helperCalls: review.helperCalls,
            helperDefinitions: review.helperDefinitions,
            externalImports: dedupe([
              ...externalImports,
              ...review.helperDefinitions.flatMap((helper) => flattenHelpers([helper]).flatMap((h) => h.externalImports)),
            ]),
            assertions: review.assertions,
          })
        }
        return
      }
      node.forEachChild(visit)
    }

    visit(src)
  }
  return out
}

function readRelativeImports(file: string, src: ts.SourceFile): Map<string, ImportedHelper> {
  const imports = new Map<string, ImportedHelper>()
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const resolved = resolveImport(file, specifier)
    if (!resolved) continue
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, { name: clause.name.text, file: resolved })
    const named = clause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        imports.set(element.name.text, {
          name: element.propertyName?.text ?? element.name.text,
          file: resolved,
        })
      }
    }
  }
  return imports
}

function readExternalImports(src: ts.SourceFile): string[] {
  const imports: string[] = []
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text.startsWith('.')) continue
    imports.push(cleanSnippet(stmt.getText(src)))
  }
  return imports
}

function readHelperDefinition(imported: ImportedHelper, seen: Set<string>): HelperDefinition | undefined {
  const source = safeRead(imported.file)
  if (source === null) return undefined
  const src = ts.createSourceFile(imported.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = readRelativeImports(imported.file, src)
  const externalImports = readExternalImports(src)
  let found: HelperDefinition | undefined

  function visit(node: ts.Node): void {
    if (found) return
    const name = functionName(node)
    if (name !== imported.name) {
      node.forEachChild(visit)
      return
    }
    const body = functionLikeBody(node)
    const dependencies = body
      ? collectLocalDependencies(body, src, imported.file, imports, seen)
      : []
    found = {
      name,
      file: imported.file,
      snippet: cleanSnippet(node.getText(src)),
      externalImports,
      dependencies,
      assertions: body ? collectDirectAssertions(body, src) : [],
    }
  }

  visit(src)
  return found
}

function reviewTestBody(
  body: ts.Node,
  src: ts.SourceFile,
  helperFor: (name: string) => HelperDefinition | undefined,
): { helperCalls: string[]; helperDefinitions: HelperDefinition[]; assertions: TestReviewAssertion[] } {
  const helperCalls: string[] = []
  const helperDefinitions: HelperDefinition[] = []
  const assertions: TestReviewAssertion[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (isAssertionCall(node) || isWaitAssertionCall(node)) {
        assertions.push(assertionFor(node, src, 'direct'))
      } else {
        const name = calledIdentifier(node)
        // A bare `expect(...)` node is the receiver of an assertion chain we
        // already counted on the outer call — it is not a helper call, nor a
        // check of its own. Skip the built-in by name so it never registers as
        // a phantom unresolvable helper; custom assertion helpers like
        // `expectLoggedIn(...)` keep their distinct name and are still graded.
        if (name && name !== 'expect' && !isPlaywrightTestCall(node) && !isNoiseHelper(name)) {
          helperCalls.push(cleanSnippet(node.getText(src)))
          const helper = helperFor(name)
          if (helper) helperDefinitions.push(helper)
          if (name.startsWith('expect')) {
            assertions.push(helperAssertion(node, src, helper))
          }
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(body)
  return {
    helperCalls: dedupe(helperCalls),
    helperDefinitions: dedupeHelpers(helperDefinitions),
    assertions: dedupeAssertions(assertions),
  }
}

function collectDirectAssertions(body: ts.Node, src: ts.SourceFile): TestReviewAssertion[] {
  const assertions: TestReviewAssertion[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && (isAssertionCall(node) || isWaitAssertionCall(node))) assertions.push(assertionFor(node, src, 'direct'))
    node.forEachChild(visit)
  }
  visit(body)
  return dedupeAssertions(assertions)
}

function collectLocalDependencies(
  body: ts.Node,
  src: ts.SourceFile,
  file: string,
  imports: Map<string, ImportedHelper>,
  seen: Set<string>,
): HelperDefinition[] {
  const dependencies: HelperDefinition[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calledIdentifier(node)
      if (name && !isNoiseHelper(name)) {
        const imported = imports.get(name) ?? (hasLocalDefinition(src, name) ? { name, file } : undefined)
        const key = imported ? `${imported.file}:${imported.name}` : ''
        if (imported && !seen.has(key)) {
          const nextSeen = new Set(seen)
          nextSeen.add(key)
          const dependency = readHelperDefinition(imported, nextSeen)
          if (dependency) dependencies.push(dependency)
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(body)
  return dedupeHelpers(dependencies)
}

function hasLocalDefinition(src: ts.SourceFile, name: string): boolean {
  let found = false
  function visit(node: ts.Node): void {
    if (found) return
    if (functionName(node) === name) {
      found = true
      return
    }
    node.forEachChild(visit)
  }
  visit(src)
  return found
}

function helperAssertion(
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

function assertionFor(
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
function classifyAssertion(snippet: string, matcher?: string): AssertionQuality {
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

function rationaleFor(quality: AssertionQuality, snippet: string, matcher?: string): string {
  if (quality === 'strict') {
    return `Uses ${matcher} against concrete expected behavior or copy.`
  }
  if (quality === 'moderate') return 'Checks a meaningful condition, but the static evidence is indirect.'
  if (quality === 'shallow') return 'Checks weak existence or quantity evidence without proving the business outcome.'
  return 'Static analysis could not confidently classify this assertion.'
}

/** Run-level wording computed from the evidence. Takes the display name so a
 *  report that kept an authored feature title doesn't open with the raw slug. */
function deterministicSummary(packet: TestReviewPacket, feature: string): string {
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

function whyItMattersFor(status: string): string {
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

function audienceTitle(title: string): string {
  const cleaned = title
    .replace(/^[A-Z]\.\s+/, '')
    .replace(/\b(incl\.?|incl)\b/gi, 'including')
    .replace(/\bauto-resolved\b/gi, 'automatically resolved')
    .replace(/\bwarn\b/gi, 'warning')
    .replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g, (match) => {
      return looksLikeIdentifier(match) ? humanizeIdentifier(match) : match
    })
    .replace(/\s*-\s*>|\s*→\s*/g, ' then ')
    .replace(/\s+/g, ' ')
    .trim()
  return sentenceCase(cleaned)
}

/** Only rewrite words that actually look like code — dotted paths, snake_case,
 *  $-prefixed, or camelCase. Ordinary prose has to survive verbatim: splitting
 *  every capitalised run turned "stops issuing OTPs" into "stops issuing ot ps". */
function looksLikeIdentifier(word: string): boolean {
  if (/[_$]/.test(word)) return true
  // A dotted word is only a property path when both sides are real names —
  // otherwise prose abbreviations ("e.g.", "i.e.") get split into "e g".
  if (word.includes('.')) return word.split('.').every((part) => part.length > 1)
  return /^[a-z][\w$]*[A-Z]/.test(word)
}

const ANNOTATION_TAG = /@[A-Za-z][\w]*-[\w.-]+/g

/** Playwright titles carry the coverage annotations inline (`@req-R3 @path-sad …`).
 *  They are metadata, not prose — the report shows them as tags beside the case
 *  and keeps the headline readable. */
function splitAnnotations(title: string): { text: string; tags: string[] } {
  const tags = dedupe(title.match(ANNOTATION_TAG) ?? [])
  return { text: title.replace(ANNOTATION_TAG, '').replace(/\s+/g, ' ').trim(), tags }
}

function comparableTitle(title: string): string {
  return splitAnnotations(title).text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function audienceFlowTitle(node: FlowNode, test: TestReviewCase): string {
  if (node.kind === 'start') return 'Start the scenario'
  if (node.kind === 'end') return node.title.replace(/^Result:/, 'Run result:')
  if (node.kind === 'assertion') return 'Check the expected outcome'
  if (node.kind === 'helper') {
    const helperName = node.title.replace(/^Helper:\s*/, '')
    // `readableActionName` never returns an empty string — it carries its own
    // 'Run the next step' fallback — so the `|| readableHelperName(…) || 'Run a
    // shared test step'` chain that used to sit here could never be reached.
    // NOTE: that also means a helper whose name yields no recognisable action
    // words gets the generic label rather than the humanised helper name the
    // dead arm intended. Changing that changes exported report text, so it is
    // recorded here rather than fixed in a coverage pass.
    return readableActionName(helperName, node.detail ?? helperName)
  }
  if (node.kind === 'setup') return 'Prepare the scenario'
  if (node.detail) return readableAction(node.detail, test)
  return 'Run the next step'
}

function audienceFlowDetail(detail: string): string {
  const nested = detail.match(/^(\d+)\s+nested assertions?$/i)
  if (nested) return `${nested[1]} check${nested[1] === '1' ? '' : 's'} inside this shared step`
  if (/\b(await|expect|const|let|return|function)\b|=>|[{}=()]|[_$]/.test(detail)) return 'Uses the recorded test step.'
  return detail
    .replace(/\bassertions?\b/gi, 'checks')
    .replace(/\bnested assertion(s)?\b/gi, 'checks inside this shared step')
    .replace(/\bnested\b/gi, 'included')
    .replace(/\bstrict\b/gi, 'exact')
    .replace(/\bunknown\b/gi, 'not graded')
}

function readableHelperName(name: string): string {
  return sentenceCase(actionFromIdentifier(name) || humanizeIdentifier(name))
}

function readableAction(statement: string, test: TestReviewCase): string {
  if (/\btest\.skip\b/.test(statement)) return 'Skip if required test setup is missing'
  const called = calledNameFromText(statement)
  if (/\bexpect\b/.test(statement)) return 'Check the expected outcome'
  if (called) return readableActionName(called, statement)
  if (/\broute|mock|intercept|fixture|seed\b/i.test(statement)) return 'Prepare test data or mocks'
  if (/\bclick\b/i.test(statement)) return 'Click the relevant control'
  if (/\bfill\b/i.test(statement)) return 'Enter the required value'
  if (/\bwaitForURL\b/i.test(statement)) return 'Wait for the expected page'
  return sentenceCase(audienceTitle(test.title))
}

function readableActionName(name: string, statement: string): string {
  if (/\bnew\s+Date\b/.test(statement)) return 'Record the start time'
  const action = actionFromIdentifier(name, assignedNameFromStatement(statement))
  return action ? sentenceCase(action) : 'Run the next step'
}

function actionFromIdentifier(name: string, assignedName?: string): string {
  const words = identifierWords(name)
  if (!words.length) return ''
  const first = words[0]
  const rest = words.slice(1)
  if (first === 'expect' || first === 'assert' || first === 'check') return `check ${readableObject(rest) || 'the expected outcome'}`
  if (first === 'mock') return `prepare ${readableObject(rest) || 'test data'}`
  if (first === 'create' || first === 'make' || first === 'build' || first === 'generate' || first === 'prepare') {
    return `prepare ${readableCreatedObject(rest, assignedName)}`
  }
  if (first === 'send' || first === 'post' || first === 'submit' || first === 'publish') {
    return `send ${readableObject(rest.filter((word) => word !== 'send' && word !== 'post')) || 'the request'}`
  }
  if (first === 'query' || first === 'read' || first === 'fetch' || first === 'get' || first === 'find') {
    return `read ${readableObject(rest) || 'the saved record'}`
  }
  if (first === 'poll' || first === 'wait') return `wait for ${readableObject(rest) || 'the expected result'}`
  if (first === 'toggle' || first === 'enable' || first === 'disable' || first === 'restore' || first === 'update' || first === 'upsert') {
    return `${first} ${readableObject(rest) || 'test data'}`
  }
  if (first === 'with') return `check ${readableObject(rest) || 'the related records'}`
  if (words.includes('click')) return 'click the relevant control'
  if (words.includes('fill')) return 'enter the required value'
  return readableObject(words)
}

function readableCreatedObject(words: string[], assignedName?: string): string {
  const targetWords = words.length ? words : identifierWords(assignedName ?? '')
  if (targetWords.includes('id') || targetWords.includes('ids')) return 'unique identifiers'
  return readableObject(targetWords) || 'test data'
}

function readableObject(words: string[]): string {
  return words
    .filter((word) => word && word !== 'async')
    .map(displayWord)
    .join(' ')
    .trim()
}

function humanizeIdentifier(value: string): string {
  const parts = value.split('.').flatMap(identifierWords)
  return readableObject(parts) || value
}

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_$.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

function displayWord(word: string): string {
  if (word === 'ids') return 'identifiers'
  if (word === 'id') return 'identifier'
  return word
}

function assignedNameFromStatement(statement: string): string | undefined {
  return statement.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)?.[1]
}

function sentenceCase(value: string): string {
  if (!value) return value
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

function confidenceForAssertions(assertions: TestReviewAssertion[]): string {
  const summary = qualitySummaryForAudience(assertions)
  if (assertions.some((assertion) => assertion.quality === 'strict')) {
    return `Confidence: ${summary}. At least one check confirms an exact expected value or behavior.`
  }
  if (assertions.some((assertion) => assertion.quality === 'moderate')) {
    return `Confidence: ${summary}. The checks cover meaningful behavior, but some evidence is indirect.`
  }
  return `Confidence: ${summary}. Review the engineering evidence before relying on this scenario as strong proof.`
}

// The rewrite is a parameter rather than a field on `options`: both callers
// normalize (falling back to the deterministic rewrite) before building the
// flowcharts from it, so re-deriving it here only re-ran an idempotent
// normalize on an already-normalized value and left two arms that could never
// be taken.
async function renderHtml(
  packet: TestReviewPacket,
  options: AssertionHtmlOptions,
  rewrite: EvaluationRewrite,
  flowcharts: TestFlowchart[],
): Promise<string> {
  const displayFeature = rewrite.featureTitle?.trim() || titleCaseFeatureName(packet.feature)
  const testIds = uniqueSectionIds(packet.tests.map((test, idx) => `${idx + 1}-${test.title}`))
  const flowchartByTestName = new Map(flowcharts.map((flowchart) => [flowchart.testName, flowchart]))
  // Coverage strength is keyed by the source test title (== ledger test name).
  const coverageByTitle = new Map<string, TestCoverage>()
  if (options.coverage) for (const t of options.coverage.tests) coverageByTitle.set(t.name, t)
  const implementationId = 'local-codebase-implementations'
  const counts = testStatusCounts(packet.tests)
  const groups = groupTestsBySpec(packet.tests, testIds, rewrite)
  const externalImports = dedupe(packet.tests.flatMap((test) => test.externalImports)).sort()
  const helpers = flattenHelpers(packet.tests.flatMap((test) => test.helperDefinitions))

  const caseCards = await Promise.all(packet.tests.map(async (test, idx) => {
    const videoLinks = options.videoLinksByTestName?.[test.name] ?? []
    // Always present: `createFlowcharts` emits one entry per packet test keyed
    // by `test.name`, and it is the only thing renderHtml is ever called with.
    const flowchart = flowchartByTestName.get(test.name)!
    const audienceCase = rewrite.cases[idx]
    const cov = coverageByTitle.get(test.title)
    const bucket = statusBucket(test.status)
    const reqs = cov?.requirements ?? []
    const raw = splitAnnotations(test.title)
    const headline = displayCaseTitle(audienceCase.title, test.title)
    // The raw Playwright title only earns a line when it says something the
    // headline doesn't — otherwise it is the same sentence twice.
    const showSubline = comparableTitle(test.title) !== comparableTitle(headline)
    // When coverage exists it's the headline (depth); specificity is demoted to a
    // secondary, clearly-different axis. Without coverage, specificity stands alone.
    return `
      <article class="case" id="${escapeAttr(testIds[idx])}" data-status="${escapeAttr(bucket)}" data-open="true" data-search="${escapeAttr(searchIndexFor(test, audienceCase.title, reqs))}">
        <div class="case-head">
          <button class="case-toggle" type="button" aria-expanded="true" aria-controls="${escapeAttr(testIds[idx])}-body">
            <span class="case-index">${String(idx + 1).padStart(2, '0')}</span>
            <span class="case-headline">
              <span class="case-title">${escapeHtml(headline)}</span>
              ${showSubline ? `<span class="case-subline">${escapeHtml(raw.text)}</span>` : ''}
              ${raw.tags.length ? `<span class="tags">${raw.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
            </span>
            <span class="case-head-right">
              ${renderStatusPill(test.status)}
              ${typeof test.durationMs === 'number' ? `<span class="case-duration">${escapeHtml(formatMs(test.durationMs))}</span>` : ''}
              <span class="case-chevron" aria-hidden="true"></span>
            </span>
          </button>
        </div>
        <div class="case-body" id="${escapeAttr(testIds[idx])}-body">
          <dl class="facts">
            ${cov ? `<div><dt>Coverage strength</dt><dd>${renderCoverageStrength(cov)}</dd></div>` : ''}
            <div><dt>${cov ? 'Assertion specificity' : 'Check specificity'}</dt><dd>${escapeHtml(qualitySummaryForAudience(test.assertions))}</dd></div>
            ${test.location ? `<div><dt>Declared at</dt><dd><code>${escapeHtml(shortLocation(test.location))}</code></dd></div>` : ''}
          </dl>
          <p class="case-explainer">${escapeHtml(audienceCase.whatWasChecked)}</p>
          ${bucket === 'notRun' ? NEVER_RAN_CALLOUT : ''}
          ${renderFailureDetail(test)}
          ${renderFlowchartSection(flowchart, audienceCase.title)}
          <div class="drawers">
            <details class="drawer test-code-details">
              <summary>Test code</summary>
              <div class="drawer-body">${test.testBody ? await renderTestCode(test.testBody) : '<p class="muted">Source unavailable.</p>'}</div>
            </details>
            <details class="drawer checks-details">
              <summary>Checks</summary>
              <div class="drawer-body">
                <p class="confidence-note">${escapeHtml(audienceCase.confidence)}</p>
                <ul class="assertions">${test.assertions.map(renderAssertionHtml).join('')}</ul>
              </div>
            </details>
          </div>
          ${videoLinks.length ? renderVideoSection(videoLinks) : ''}
        </div>
      </article>
    `
  }))

  const caseSections = groups.map((group) => `
    <section class="spec-group" data-group>
      <h2 class="spec-heading" id="${escapeAttr(group.id)}">
        <span class="spec-name">${escapeHtml(group.label)}</span>
        <span class="spec-count">${group.items.length} ${group.items.length === 1 ? 'test' : 'tests'}</span>
      </h2>
      ${group.items.map((item) => caseCards[item.index]).join('')}
    </section>
  `).join('')

  const implementations = await renderImplementations(externalImports, helpers, implementationId)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Evaluation Report: ${escapeHtml(displayFeature)}</title>
  <style>${ASSERTION_HTML_CSS}</style>
  <script>${THEME_BOOT_SCRIPT}</script>
</head>
<body>
  <a class="skip-link" href="#report">Skip to report</a>
  <header class="topbar">
    <div class="topbar-inner">
      <span class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text">Canary Lab<span class="brand-sub">Evaluation report</span></span>
      </span>
      <span class="topbar-now" data-topbar-now aria-live="polite"></span>
      <div class="topbar-tools">
        <code class="run-chip" title="Run id">${escapeHtml(packet.runId)}</code>
        ${THEME_SWITCH_HTML}
      </div>
    </div>
  </header>
  <div class="shell">
    <aside class="rail">
      <nav class="nav" aria-label="Test cases">
        <div class="nav-search">
          <input type="search" id="case-search" placeholder="Search tests…" autocomplete="off" aria-label="Search test cases">
        </div>
        ${renderFilterChips(counts)}
        <p class="nav-count" data-nav-count>${packet.tests.length} of ${packet.tests.length} shown</p>
        <div class="nav-actions">
          <button type="button" data-expand-all>Expand all</button>
          <button type="button" data-collapse-all>Collapse all</button>
        </div>
        ${renderNavGroups(groups)}
        <p class="nav-empty" data-nav-empty hidden>No test matches this filter.</p>
      </nav>
    </aside>
    <main id="report">
      <header class="masthead">
        <p class="eyebrow">Evaluation report</p>
        <h1>${escapeHtml(displayFeature)}</h1>
        <p class="lede">${escapeHtml(rewrite.summary)}</p>
        ${renderVerdict(packet, counts)}
        ${counts.notRun > 0 ? renderNeverRanNotice(counts.notRun, packet.tests.length) : ''}
        <dl class="run-meta">
          <div><dt>Run</dt><dd><code>${escapeHtml(packet.runId)}</code></dd></div>
          <div><dt>Status</dt><dd>${renderStatusPill(packet.status)}</dd></div>
          <div><dt>Result</dt><dd>${packet.passed}/${packet.total} passed</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(packet.startedAt)}</dd></div>
          ${packet.endedAt ? `<div><dt>Ended</dt><dd>${escapeHtml(packet.endedAt)}</dd></div>` : ''}
        </dl>
      </header>
      ${options.coverage ? renderCoverageOverview(options.coverage) : ''}
      ${renderMatrix(groups, packet.tests)}
      <section id="test-cases" aria-label="Test cases">
        <h2 class="rule-heading">Test cases<span>${packet.tests.length}</span></h2>
        ${caseSections}
      </section>
      ${implementations}
      <footer class="report-foot">
        <span>Generated by Canary Lab from run <code>${escapeHtml(packet.runId)}</code>.</span>
        <span>Every case below is a test declared by this feature — including the ones this run never reached.</span>
      </footer>
    </main>
  </div>
  <button class="to-top" type="button" data-to-top aria-label="Back to top"></button>
  <script>${ASSERTION_HTML_SCRIPT}</script>
</body>
</html>
`
}

interface NavItem {
  index: number
  id: string
  label: string
  status: keyof TestStatusCounts
  rawTitle: string
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

/** Cases are grouped by the spec file they're declared in — with 20+ tests a flat
 *  list stops being navigable, and the spec file is the grouping a reader already
 *  has in their head. Tests with no known location fall into one trailing group. */
function groupTestsBySpec(tests: TestReviewCase[], testIds: string[], rewrite: EvaluationRewrite): NavGroup[] {
  const groups = new Map<string, NavGroup>()
  tests.forEach((test, index) => {
    const label = test.location ? specFileLabel(test.location) : 'Other tests'
    let group = groups.get(label)
    if (!group) {
      group = { id: `spec-${statusClass(label)}`, label, items: [] }
      groups.set(label, group)
    }
    group.items.push({
      index,
      id: testIds[index],
      label: displayCaseTitle(rewrite.cases[index].title, test.title),
      status: statusBucket(test.status),
      rawTitle: test.title,
    })
  })
  return [...groups.values()]
}

/** The headline a reader sees. Annotation tags are stripped (they render as tags),
 *  and a rewrite that stripped down to nothing falls back to the raw title rather
 *  than leaving the case unlabelled. */
function displayCaseTitle(audienceTitleText: string, rawTitle: string): string {
  // Sentence-cased AFTER the tags come off: `@req-R5 @path-sad refuses to …`
  // otherwise renders with a lowercase opening word.
  return sentenceCase(splitAnnotations(audienceTitleText).text || splitAnnotations(rawTitle).text || rawTitle)
}

function specFileLabel(location: string): string {
  const file = sourceKey(location).replace(/:\d+$/, '')
  return file.split(/[\\/]/).pop() || file
}

/** `/very/long/abs/path/e2e/foo.spec.ts:138` → `e2e/foo.spec.ts:138`. The absolute
 *  prefix is machine-specific noise in a document meant to be read by a person. */
function shortLocation(location: string): string {
  const parts = location.split(/[\\/]/)
  return parts.slice(-2).join('/')
}

function searchIndexFor(test: TestReviewCase, audienceTitleText: string, requirements: string[]): string {
  return [audienceTitleText, test.title, test.status, ...requirements.map((id) => `@req-${id}`)]
    .join(' ')
    .toLowerCase()
}

const VERDICT_SEGMENTS: Array<{ key: keyof TestStatusCounts; label: string }> = [
  { key: 'passed', label: 'Passed' },
  { key: 'failed', label: 'Failed' },
  { key: 'interrupted', label: 'Interrupted' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'notRun', label: 'Never ran' },
]

/** The headline the old report couldn't show: every declared test placed in exactly
 *  one bucket, summing to the declared total. The pass fraction is read straight
 *  off the run summary — never derived as `total - failed`. */
function renderVerdict(packet: TestReviewPacket, counts: TestStatusCounts): string {
  const declared = packet.tests.length || 1
  const bar = VERDICT_SEGMENTS
    .filter((segment) => counts[segment.key] > 0)
    .map((segment) => `<span class="bar-seg bar-${escapeAttr(statusClass(segment.key))}" style="flex-grow:${counts[segment.key]}" title="${escapeAttr(`${segment.label}: ${counts[segment.key]}`)}"></span>`)
    .join('')
  const legend = VERDICT_SEGMENTS
    .map((segment) => `<li class="legend-item${counts[segment.key] === 0 ? ' is-zero' : ''}" data-legend="${escapeAttr(segment.key)}">
      <span class="legend-dot dot-${escapeAttr(statusClass(segment.key))}"></span>
      <span class="legend-value">${counts[segment.key]}</span>
      <span class="legend-label">${escapeHtml(segment.label)}</span>
    </li>`)
    .join('')
  return `<section class="verdict" aria-label="Run verdict">
    <div class="verdict-figure">
      <span class="verdict-ratio"><strong>${packet.passed}</strong><span class="verdict-slash">/</span>${packet.total}</span>
      <span class="verdict-caption">tests passed of ${packet.total} declared</span>
    </div>
    <div class="verdict-chart">
      <div class="bar" role="img" aria-label="${escapeAttr(VERDICT_SEGMENTS.map((s) => `${s.label} ${counts[s.key]}`).join(', '))}">${bar}</div>
      <ul class="legend">${legend}</ul>
    </div>
  </section>`
}

function renderNeverRanNotice(notRun: number, declared: number): string {
  return `<aside class="notice notice-notrun" role="note">
    <span class="notice-badge">Incomplete run</span>
    <p><strong>${notRun} of ${declared} declared tests never ran.</strong> Execution stopped before reaching them, so they carry no result in either direction — they are listed below as evidence of what this run did <em>not</em> verify, not as passes.</p>
  </aside>`
}

const NEVER_RAN_CALLOUT = `<div class="case-notrun">This test was declared but never executed in this run. Everything shown below is read from its source — there is no recorded result.</div>`

function renderFailureDetail(test: TestReviewCase): string {
  if (!test.error) return ''
  return `<section class="failure">
    <h3>Why it failed</h3>
    <pre class="failure-message">${escapeHtml(test.error.message.trim())}</pre>
    ${test.error.snippet ? `<pre class="failure-snippet">${escapeHtml(test.error.snippet.replace(/\s+$/, ''))}</pre>` : ''}
  </section>`
}

function renderStatusPill(status: string): string {
  return `<span class="pill pill-${escapeAttr(statusClass(statusBucket(status)))}">${escapeHtml(status)}</span>`
}

function renderFilterChips(counts: TestStatusCounts): string {
  const chips = [
    { key: 'all', label: 'All', count: Object.values(counts).reduce((a, b) => a + b, 0) },
    ...VERDICT_SEGMENTS.map((segment) => ({ key: segment.key as string, label: segment.label, count: counts[segment.key] })),
  ].filter((chip) => chip.count > 0)
  return `<div class="filters" role="group" aria-label="Filter by result">
    ${chips.map((chip) => `<button type="button" class="chip chip-${escapeAttr(statusClass(chip.key))}" data-filter="${escapeAttr(chip.key)}"${chip.key === 'all' ? ' aria-pressed="true"' : ' aria-pressed="false"'}>
      <span class="chip-dot dot-${escapeAttr(statusClass(chip.key))}"></span>${escapeHtml(chip.label)}<span class="chip-count">${chip.count}</span>
    </button>`).join('')}
  </div>`
}

function renderNavGroups(groups: NavGroup[]): string {
  return `<div class="nav-groups">
    ${groups.map((group) => `<section class="nav-group" data-nav-group>
      <h3>${escapeHtml(group.label)}</h3>
      <ol>
        ${group.items.map((item) => `<li data-nav-item data-status="${escapeAttr(item.status)}">
          <a href="#${escapeAttr(item.id)}" data-section-id="${escapeAttr(item.id)}">
            <span class="nav-dot dot-${escapeAttr(statusClass(item.status))}"></span>
            <span class="nav-num">${String(item.index + 1).padStart(2, '0')}</span>
            <span class="nav-label">${escapeHtml(item.label)}</span>
          </a>
        </li>`).join('')}
      </ol>
    </section>`).join('')}
  </div>`
}

/** A one-screen map of the whole suite: one cell per declared test, coloured by
 *  result. With 23 cases this is the fastest read in the document — and the only
 *  place the never-ran block is visible as a block. */
function renderMatrix(groups: NavGroup[], tests: TestReviewCase[]): string {
  if (tests.length < 2) return ''
  return `<section class="matrix" aria-label="Result map">
    <h2 class="rule-heading">Result map<span>${tests.length}</span></h2>
    <div class="matrix-groups">
      ${groups.map((group) => `<div class="matrix-group">
        <p class="matrix-label">${escapeHtml(group.label)}</p>
        <div class="matrix-cells">
          ${group.items.map((item) => `<a class="cell cell-${escapeAttr(statusClass(item.status))}" href="#${escapeAttr(item.id)}" data-matrix-cell data-status="${escapeAttr(item.status)}" title="${escapeAttr(`${item.index + 1}. ${item.rawTitle} — ${item.status === 'notRun' ? 'never ran' : item.status}`)}"><span>${item.index + 1}</span></a>`).join('')}
        </div>
      </div>`).join('')}
    </div>
  </section>`
}

// Per-test coverage strength (depth) + the requirements it maps to. The headline
// quality signal when a coverage ledger exists.
function renderCoverageStrength(tc: TestCoverage): string {
  const strength = tc.strength ?? 'shallow'
  const label = STRENGTH_LABEL[strength]
  const reqs = tc.requirements.length
    ? `covers ${tc.requirements.map((id) => `@req-${id}`).join(', ')}`
    : 'unmapped'
  return `<strong class="strength strength-${escapeAttr(strength)}">${escapeHtml(label)}</strong> <span class="muted">${escapeHtml(reqs)}</span>`
}

// Feature-level Semantic Coverage banner: breadth (mapped) vs depth-by-paths
// (covered), independent of whether the run passed.
function renderCoverageOverview(coverage: CoverageLedger): string {
  const t = coverage.totals
  return `<section class="coverage" aria-label="Semantic coverage">
    <h2 class="rule-heading">Semantic coverage<span>run-free</span></h2>
    <div class="stat-row">
      <div class="stat"><span class="stat-value">${coverage.coveragePct}<span class="stat-unit">%</span></span><span class="stat-label">covered · every path</span></div>
      <div class="stat"><span class="stat-value">${coverage.mappedPct}<span class="stat-unit">%</span></span><span class="stat-label">mapped · has a test</span></div>
      <div class="stat"><span class="stat-value">${t.covered}<span class="stat-unit">/${t.total}</span></span><span class="stat-label">requirements covered</span></div>
    </div>
    <p class="muted">Coverage measures whether a test maps to each requirement's declared paths. It is independent of this run — a requirement can be fully covered by a test that never executed (${t.untested} untested, ${t.pathIncomplete} path-incomplete).</p>
  </section>`
}

function renderFlowchartSection(flowchart: TestFlowchart, title: string): string {
  return `<section class="subsection flow-section">
    <h3>How the test runs</h3>
    <figure class="flow-frame" aria-label="Flow diagram for ${escapeAttr(title)}">
      ${flowchart.svg}
    </figure>
  </section>`
}

async function renderTestCode(source: string): Promise<string> {
  const highlighted = await highlightCode(source)
  return addCodeLineMarkers(highlighted)
}

function renderVideoSection(videoLinks: string[]): string {
  return `<section class="subsection video-section">
    <h3>Video</h3>
    ${videoLinks.map((video) => `<figure class="video-frame"><video controls preload="metadata" src="${escapeAttr(video)}"></video><figcaption><a href="${escapeAttr(video)}">${escapeHtml(video)}</a></figcaption></figure>`).join('')}
  </section>`
}

async function renderImplementations(externalImports: string[], helpers: HelperDefinition[], id: string): Promise<string> {
  if (!externalImports.length && !helpers.length) return ''
  const source = [
    ...externalImports,
    ...helpers.map((helper) => helper.snippet),
  ].join('\n\n')
  return `<section class="implementations" id="${escapeAttr(id)}">
    <details class="drawer">
      <summary>Helper functions used</summary>
      <div class="drawer-body">${await highlightCode(source)}</div>
    </details>
  </section>`
}

function createFlowcharts(packet: TestReviewPacket, rewrite: EvaluationRewrite): TestFlowchart[] {
  return packet.tests.map((test, idx) => {
    // One case per test is an invariant of both producers: `normalizeEvaluationRewrite`
    // rejects any input whose `cases.length` differs from `packet.tests.length`,
    // and `deterministicEvaluationRewrite` maps straight over `packet.tests`.
    const rewriteCase = rewrite.cases[idx]
    const steps = applyFlowStepRewrite(flowNodesForTest(test), rewriteCase.flowSteps)
    return {
      testName: test.name,
      steps,
      svg: renderFlowchartSvg(steps, rewriteCase.title, idx),
    }
  })
}

function applyFlowStepRewrite(nodes: FlowNode[], steps: EvaluationRewriteFlowStep[] | undefined): FlowNode[] {
  if (!steps?.length) return nodes
  return nodes.map((node, idx) => {
    const rewrite = steps[idx]
    if (!rewrite?.title) return node
    return {
      ...node,
      title: rewrite.title,
      ...(rewrite.detail !== undefined ? { detail: rewrite.detail } : {}),
    }
  })
}

// Cap the flow at a readable length; an overflow is summarized in one node so even
// a huge test stays scannable.
const MAX_FLOW_STEPS = 24

function flowNodesForTest(test: TestReviewCase): FlowNode[] {
  if (!test.testBody) {
    return [
      { kind: 'start', title: test.title },
      { kind: 'setup', title: 'Source unavailable', detail: qualitySummary(test.assertions) || 'No static source match' },
      { kind: 'end', title: `Result: ${test.status}` },
    ]
  }
  const allSteps = testBodyStatements(test).map((statement) => flowNodeForStatement(statement.text, test, statement.line))
  const stepNodes: FlowNode[] = allSteps.length > MAX_FLOW_STEPS
    ? [
        ...allSteps.slice(0, MAX_FLOW_STEPS),
        { kind: 'setup', title: `+${allSteps.length - MAX_FLOW_STEPS} more steps`, detail: 'further statements omitted for brevity' },
      ]
    : allSteps
  return [
    { kind: 'start', title: test.title },
    ...stepNodes,
    { kind: 'end', title: `Result: ${test.status}` },
  ]
}

// A leaf statement reads as a flow step when it DOES something — an `await` or a
// call (awaited actions, helper calls, `expect(...)` assertions). Pure literal /
// identifier declarations (`const url = '…'`) are flow noise and are dropped.
function isMeaningfulFlowStatement(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n) || ts.isAwaitExpression(n) || ts.isNewExpression(n)) { found = true; return }
    n.forEachChild(visit)
  }
  visit(node)
  return found
}

function testBodyStatements(test: TestReviewCase): Array<{ text: string; line: number }> {
  const wrapped = `async function __canaryReviewBody() ${test.testBody}`
  const src = ts.createSourceFile('assertion-flow.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fn = src.statements.find(ts.isFunctionDeclaration)
  if (!fn?.body) {
    return test.testBody
      .split('\n')
      .map((line, idx) => ({ text: cleanSnippet(line), line: idx + 1 }))
      .filter((item) => item.text)
  }
  // Flatten control-flow containers so a test wrapped in `try {…}` (or if/loops)
  // surfaces its real steps in source order instead of collapsing into one node.
  // We descend into statement containers only — never into expressions / arrow
  // callbacks — so a leaf stays one node.
  const leaves: ts.Statement[] = []
  const walk = (stmt: ts.Statement): void => {
    if (ts.isBlock(stmt)) { stmt.statements.forEach(walk); return }
    if (ts.isTryStatement(stmt)) {
      walk(stmt.tryBlock)
      if (stmt.catchClause) walk(stmt.catchClause.block)
      if (stmt.finallyBlock) walk(stmt.finallyBlock)
      return
    }
    if (ts.isIfStatement(stmt)) {
      walk(stmt.thenStatement)
      if (stmt.elseStatement) walk(stmt.elseStatement)
      return
    }
    if (ts.isIterationStatement(stmt, false)) { walk(stmt.statement); return }
    leaves.push(stmt)
  }
  fn.body.statements.forEach(walk)
  return leaves
    .filter(isMeaningfulFlowStatement)
    .map((statement) => ({
      text: cleanSnippet(statement.getText(src)),
      line: src.getLineAndCharacterOfPosition(statement.getStart(src)).line + 1,
    }))
}

function flowNodeForStatement(statement: string, test: TestReviewCase, codeLine: number): FlowNode {
  const assertion = test.assertions.find((item) => item.snippet === statement || statement.includes(item.snippet) || item.snippet.includes(statement))
  if (assertion) {
    return { kind: 'assertion', title: `${assertion.quality} assertion`, detail: inline(assertion.snippet), codeLine }
  }
  const helper = helperForStatement(statement, test)
  if (helper) {
    const nestedCount = helper.assertions.length + helper.dependencies.reduce((count, dep) => count + flattenHelpers([dep]).reduce((sum, item) => sum + item.assertions.length, 0), 0)
    return {
      kind: 'helper',
      title: `Helper: ${helper.name}`,
      detail: nestedCount ? `${nestedCount} nested assertion${nestedCount === 1 ? '' : 's'}` : inline(statement),
      codeLine,
    }
  }
  return {
    kind: setupLikeStatement(statement) ? 'setup' : 'action',
    title: setupLikeStatement(statement) ? 'Setup' : 'Action',
    detail: inline(statement),
    codeLine,
  }
}

function helperForStatement(statement: string, test: TestReviewCase): HelperDefinition | undefined {
  const helperName = calledNameFromText(statement)
  if (!helperName) return undefined
  return flattenHelpers(test.helperDefinitions).find((helper) => helper.name === helperName || statement.includes(helper.name))
}

function calledNameFromText(statement: string): string | undefined {
  const match = statement.match(/(?:await\s+|return\s+)?(?:\(?\s*)?([A-Za-z_$][\w$]*)\s*\(/)
  return match?.[1]
}

function setupLikeStatement(statement: string): boolean {
  return /\b(route|mock|intercept|fixture|seed|login|storageState|setExtraHTTPHeaders|addInitScript)\b/i.test(statement)
}

function renderFlowchartSvg(nodes: FlowNode[], title: string, chartIndex: number): string {
  // Every chart owns its <defs> ids. Sharing one `#nodeShadow` across all charts
  // means the whole report's node shapes vanish the moment the case that happens
  // to hold the first definition is collapsed — a `display:none` subtree stops
  // providing a usable filter, and every reference to it renders as nothing.
  const arrowId = `arrow-${chartIndex}`
  const shadowId = `node-shadow-${chartIndex}`
  const width = 1280
  const nodesPerRow = 4
  const rowHeight = 150
  const rows = Math.max(1, Math.ceil(nodes.length / nodesPerRow))
  const height = 36 + rows * rowHeight
  const nodeWidth = 230
  const nodeHeight = 84
  const gap = 62
  const startX = 50
  const startY = 38
  // Every colour is a CSS custom property so the inline SVG recolours with the
  // document's light/dark switch — an SVG with baked hex fills is a white slab
  // in dark mode.
  const colors: Record<FlowNode['kind'], { fill: string; stroke: string; text: string }> = {
    start: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
    setup: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
    action: { fill: 'var(--flow-action-fill)', stroke: 'var(--flow-action-line)', text: 'var(--flow-action-text)' },
    helper: { fill: 'var(--flow-helper-fill)', stroke: 'var(--flow-helper-line)', text: 'var(--flow-helper-text)' },
    assertion: { fill: 'var(--flow-assert-fill)', stroke: 'var(--flow-assert-line)', text: 'var(--flow-assert-text)' },
    end: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
  }
  const body = nodes.map((node, idx) => {
    const row = Math.floor(idx / nodesPerRow)
    const col = idx % nodesPerRow
    const x = startX + col * (nodeWidth + gap)
    const y = startY + row * rowHeight
    const color = node.kind === 'end' ? resultColor(node.title) : colors[node.kind]
    const titleLines = clampSvgText(node.title, 25, 2)
    const detailLines = node.detail ? clampSvgText(node.detail, 31, 2) : []
    const text = renderNodeText({ x, y, width: nodeWidth, height: nodeHeight, color: color.text, titleLines, detailLines })
    const next = idx < nodes.length - 1 ? {
      row: Math.floor((idx + 1) / nodesPerRow),
      col: (idx + 1) % nodesPerRow,
    } : null
    const arrow = next
      ? next.row === row
        ? `<path class="connector" d="M${x + nodeWidth + 10} ${y + nodeHeight / 2} L${x + nodeWidth + gap - 12} ${y + nodeHeight / 2}" marker-end="url(#${arrowId})" />`
        : rowWrapConnector({ x, y, nodeWidth, nodeHeight, rowHeight, startX, nextTop: startY + next.row * rowHeight, arrowId })
      : ''
    const codeAttr = typeof node.codeLine === 'number' ? ` data-code-line="${node.codeLine}" tabindex="0"` : ''
    return `<g class="flow-node"${codeAttr}>
      <title>${escapeHtml(node.detail ? `${node.title}: ${node.detail}` : node.title)}</title>
      ${nodeShape(node.kind, x, y, nodeWidth, nodeHeight, color.fill, color.stroke, shadowId)}
      ${text}
      ${arrow}
    </g>`
  }).join('\n')
  return `<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evaluation flow for ${escapeAttr(title)}">
  <defs>
    <marker id="${arrowId}" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L7,3 z" class="arrowhead" />
    </marker>
    <filter id="${shadowId}" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" />
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="var(--flow-bg)" />
  <style>.connector{fill:none;stroke:var(--flow-line);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.arrowhead{fill:var(--flow-line)}feDropShadow{flood-color:var(--flow-shadow);flood-opacity:1}.flow-node{cursor:pointer}.flow-node:focus{outline:none}.flow-node.is-active rect,.flow-node.is-active polygon,.flow-node.is-active path{stroke-width:3}</style>
  <style>text{font-family:var(--font-sans)}</style>
  ${body}
</svg>
`
}

/** The step that carries on to the next row. Drawn as a stepped path down into
 *  the gutter, back along it and down into the next row's first node — a single
 *  bezier across the full width read as a stray swoop under the diagram. */
function rowWrapConnector(args: {
  x: number
  y: number
  nodeWidth: number
  nodeHeight: number
  rowHeight: number
  startX: number
  nextTop: number
  arrowId: string
}): string {
  const radius = 10
  const from = args.x + args.nodeWidth / 2
  const to = args.startX + args.nodeWidth / 2
  const gutter = args.y + args.nodeHeight + (args.rowHeight - args.nodeHeight) / 2
  const d = [
    `M${from} ${args.y + args.nodeHeight + 6}`,
    `V${gutter - radius}`,
    `Q${from} ${gutter} ${from - radius} ${gutter}`,
    `H${to + radius}`,
    `Q${to} ${gutter} ${to} ${gutter + radius}`,
    `V${args.nextTop - 10}`,
  ].join(' ')
  return `<path class="connector" d="${d}" marker-end="url(#${args.arrowId})" />`
}

function renderNodeText(args: {
  x: number
  y: number
  width: number
  height: number
  color: string
  titleLines: string[]
  detailLines: string[]
}): string {
  const titleSize = 14
  const detailSize = 11
  const titleGap = 16
  const detailGap = 14
  const blockGap = args.titleLines.length && args.detailLines.length ? 8 : 0
  const blockHeight =
    (args.titleLines.length * titleGap) +
    blockGap +
    (args.detailLines.length * detailGap)
  let cursor = args.y + (args.height - blockHeight) / 2 + 12
  const title = args.titleLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${titleSize}" font-weight="800" fill="${args.color}">${escapeHtml(line)}</text>`
    cursor += titleGap
    return out
  })
  if (blockGap) cursor += blockGap
  const detail = args.detailLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${detailSize}" fill="var(--flow-detail-text)">${escapeHtml(line)}</text>`
    cursor += detailGap
    return out
  })
  return [...title, ...detail].join('')
}

function resultColor(title: string): { fill: string; stroke: string; text: string } {
  const normalized = title.toLowerCase()
  if (normalized.includes('passed') || normalized.includes('succeed') || normalized.includes('success')) {
    return { fill: 'var(--flow-pass-fill)', stroke: 'var(--flow-pass-line)', text: 'var(--flow-pass-text)' }
  }
  if (normalized.includes('failed') || normalized.includes('fail')) {
    return { fill: 'var(--flow-fail-fill)', stroke: 'var(--flow-fail-line)', text: 'var(--flow-fail-text)' }
  }
  return { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' }
}

function nodeShape(kind: FlowNode['kind'], x: number, y: number, width: number, height: number, fill: string, stroke: string, filterId: string): string {
  if (kind === 'assertion') {
    const points = [
      `${x + 18},${y}`,
      `${x + width - 18},${y}`,
      `${x + width},${y + height / 2}`,
      `${x + width - 18},${y + height}`,
      `${x + 18},${y + height}`,
      `${x},${y + height / 2}`,
    ].join(' ')
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  if (kind === 'start' || kind === 'end') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  if (kind === 'setup') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 5" filter="url(#${filterId})" />`
  }
  if (kind === 'helper') {
    return `<path d="M${x} ${y + 10} Q${x} ${y} ${x + 10} ${y} H${x + width - 10} Q${x + width} ${y} ${x + width} ${y + 10} V${y + height - 10} Q${x + width} ${y + height} ${x + width - 10} ${y + height} H${x + 10} Q${x} ${y + height} ${x} ${y + height - 10} Z M${x + 12} ${y} V${y + height}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
}

function wrapSvgText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').flatMap((word) => splitLongWord(word, maxChars)).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function clampSvgText(text: string, maxChars: number, maxLines: number): string[] {
  const lines = wrapSvgText(text, maxChars)
  if (lines.length <= maxLines) return lines
  const out = lines.slice(0, maxLines)
  out[maxLines - 1] = `${out[maxLines - 1].slice(0, Math.max(0, maxChars - 1)).replace(/\s+$/g, '')}…`
  return out
}

function splitLongWord(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) return [word]
  const parts: string[] = []
  for (let idx = 0; idx < word.length; idx += maxChars) parts.push(word.slice(idx, idx + maxChars))
  return parts
}

function renderAssertionHtml(assertion: TestReviewAssertion): string {
  const nested = (assertion.nested ?? [])
    .map((item) => `<li>nested ${escapeHtml(qualityLabel(item.quality))}: <code>${escapeHtml(inline(item.snippet))}</code></li>`)
    .join('')
  return `<li>
    <div><span class="quality quality-${escapeAttr(assertion.quality)}">${escapeHtml(qualityLabel(assertion.quality))}</span> ${escapeHtml(rationaleForAudience(assertion.rationale))}</div>
    <details class="check-code"><summary>show code</summary><code>${escapeHtml(inline(assertion.snippet))}</code></details>
    ${assertion.helperSnippet ? `<div class="helper-ref">helper: <code>${escapeHtml(assertion.helperName ?? '')}</code></div>` : ''}
    ${nested ? `<ul>${nested}</ul>` : ''}
  </li>`
}

// Specificity vocabulary — deliberately NOT "strong/solid/…" so it never reads as
// a rival to coverage's per-test STRENGTH. This axis is "how exact is the check".
function qualityLabel(quality: AssertionQuality): string {
  if (quality === 'strict') return 'exact'
  if (quality === 'moderate') return 'behavioral'
  if (quality === 'shallow') return 'surface-level'
  return 'not graded'
}

function rationaleForAudience(rationale: string): string {
  if (rationale.startsWith('Uses ')) return 'Confirms the exact expected value or behavior.'
  if (rationale === 'Static analysis could not confidently classify this assertion.') {
    return "We couldn't auto-rate how strong this check is."
  }
  return rationale
}

async function highlightCode(source: string): Promise<string> {
  const formatted = formatCodeForDisplay(source)
  try {
    // `defaultColor: false` makes shiki emit both palettes as --shiki-light /
    // --shiki-dark custom properties instead of baking one in, so the report's
    // theme switch recolors the code with it. Offline-safe: no runtime shiki.
    return await codeToHtml(formatted, {
      lang: 'typescript',
      themes: { light: 'one-light', dark: 'one-dark-pro' },
      defaultColor: false,
    })
  } catch {
    return `<pre class="fallback-code"><code>${escapeHtml(formatted)}</code></pre>`
  }
}

function addCodeLineMarkers(html: string): string {
  const match = html.match(/^([\s\S]*?<code[^>]*>)([\s\S]*?)(<\/code>[\s\S]*)$/)
  if (!match) return html
  const [, before, code, after] = match
  const lines = code.split('\n')
  const marked = lines.map((line, idx) => {
    const lineNo = idx + 1
    return `<span class="code-line" data-code-line="${lineNo}"><span class="line-number">${lineNo}</span><span class="line-source">${line || ' '}</span></span>`
  }).join('')
  return `${before}${marked}${after}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unknown'
}

/** Runs before first paint so a dark-mode reader never sees a white flash, and so
 *  a stored preference wins over the OS setting. Kept tiny and dependency-free —
 *  the report is a single file that has to work from a zip, offline. */
const THEME_BOOT_SCRIPT = `
(() => {
  try {
    const stored = localStorage.getItem('canary-evaluation-theme')
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored)
  } catch (err) { /* private mode / file:// with storage blocked — fall back to the OS setting */ }
})()
`

const THEME_SWITCH_HTML = `<div class="theme-switch" role="radiogroup" aria-label="Colour theme">
  <button type="button" data-theme-set="light" role="radio" aria-checked="false" title="Light"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><g stroke-linecap="round"><path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"/></g><span></span></svg><span class="sr-only">Light</span></button>
  <button type="button" data-theme-set="auto" role="radio" aria-checked="true" title="Match system"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.4" y="3.6" width="15.2" height="10.4" rx="1.6"/><path d="M6.5 16.8h7" stroke-linecap="round"/></svg><span class="sr-only">System</span></button>
  <button type="button" data-theme-set="dark" role="radio" aria-checked="false" title="Dark"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.2 12.3A6.8 6.8 0 0 1 7.7 3.8a6.9 6.9 0 1 0 8.5 8.5Z"/></svg><span class="sr-only">Dark</span></button>
</div>`

const ASSERTION_HTML_CSS = `
/* ------------------------------------------------------------------ *
   Canary Lab evaluation report — "editorial"

   A printed document, not a dashboard. Prose is set in a text serif at
   reading size; the sans and the monospace are chrome — labels, identifiers,
   numbers, anything the machine produced. Cards are dissolved into rules, so
   structure comes from typography and whitespace rather than from boxes.
   Saturated colour is reserved entirely for test status, which makes a glance
   at the page read as results rather than decoration.

   Every tone clears a measured floor: body text and the smallest labels at
   4.5:1 against their own surface, hairlines at 1.8:1, status pills at 4.5:1
   against their own tint — in BOTH modes.

   Both palettes are declared twice on purpose — once under
   prefers-color-scheme (so a JS-less open still respects the OS) and once
   under [data-theme] (so the switch wins in both directions).
 * ------------------------------------------------------------------ */
:root {
  color-scheme: light;

  /* Charter is the text face — a Bitstream serif designed for low-resolution
     printing, so it holds up at reading size on any screen. Everything after it
     is a same-shape fallback; no webfont is fetched, the report opens offline. */
  --font-serif: Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --font-sans: "Avenir Next", Avenir, "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", SFMono-Regular, "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;

  /* Reading type vs chrome type. Prose — the lede, every case explainer, the
     callouts — is serif at reading size; labels and data stay sans/mono. */
  --size-prose: 16.5px;
  --leading-prose: 1.72;
  --size-label: 11px;
  --track-label: 0.04em;
  --radius: 2px;

  --paper: #f6f4ef;
  --surface: #fffefb;
  --surface-2: #f0ede5;
  --surface-3: #e6e2d8;
  --ink: #1b1a17;
  --ink-2: #4a4842;
  --ink-3: #6c6a62;
  --rule: #c0b8a5;
  --rule-2: #a29982;
  --accent: #1f5b52;
  --accent-soft: #e0ecea;

  --ok: #1a6b44;        --ok-soft: #e0efe5;
  --bad: #a3241a;       --bad-soft: #f9e3e0;
  --warn: #82530a;      --warn-soft: #f7e9d1;
  --skip: #565349;      --skip-soft: #eae7de;
  --none: #6b675d;      --none-soft: #ece9e1;

  --flow-bg: #fffefb;
  --flow-line: #8c8677;
  --flow-shadow: rgba(40, 36, 28, 0.08);
  --flow-neutral-fill: #f0ede5;  --flow-neutral-line: #a8a08c;  --flow-neutral-text: #3a3833;
  --flow-action-fill: #e6ecf2;   --flow-action-line: #4e7391;   --flow-action-text: #223a4a;
  --flow-helper-fill: #ece7f0;   --flow-helper-line: #7c6b91;   --flow-helper-text: #3d3247;
  --flow-assert-fill: #f7edd8;   --flow-assert-line: #ad8534;   --flow-assert-text: #533c0e;
  --flow-pass-fill: #e0efe5;     --flow-pass-line: #2f7d55;     --flow-pass-text: #14472e;
  --flow-fail-fill: #f9e3e0;     --flow-fail-line: #b04034;     --flow-fail-text: #6d1d16;
  --flow-detail-text: #5c5a52;
}

:root[data-theme="dark"] { color-scheme: dark; }

/* The dark palette, declared once per signal. The OS block is scoped with
   :not([data-theme="light"]) so an explicit "light" choice still wins on a
   dark-mode machine. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #121210;
    --surface: #1a1a17;
    --surface-2: #22221e;
    --surface-3: #2c2c27;
    --ink: #f2efe7;
    --ink-2: #b3afa4;
    --ink-3: #95917f;
    --rule: #47473d;
    --rule-2: #5b5b4f;
    --accent: #69cfbe;
    --accent-soft: #12302c;

    --ok: #63c98d;        --ok-soft: #14271c;
    --bad: #f78d7e;       --bad-soft: #2f1712;
    --warn: #e5b565;      --warn-soft: #2d2312;
    --skip: #b0aba0;      --skip-soft: #242420;
    --none: #8b877d;      --none-soft: #1f1f1b;

    --flow-bg: #1a1a17;
    --flow-line: #6d6a5f;
    --flow-shadow: rgba(0, 0, 0, 0.5);
    --flow-neutral-fill: #22221e;  --flow-neutral-line: #5f5c52;  --flow-neutral-text: #d5d1c6;
    --flow-action-fill: #1c2733;   --flow-action-line: #5b829e;   --flow-action-text: #b9cddb;
    --flow-helper-fill: #241f2b;   --flow-helper-line: #8a789e;   --flow-helper-text: #cfc3dc;
    --flow-assert-fill: #2c2413;   --flow-assert-line: #b99340;   --flow-assert-text: #ecd6a2;
    --flow-pass-fill: #14271c;     --flow-pass-line: #3f9c68;     --flow-pass-text: #a9e6c1;
    --flow-fail-fill: #2f1712;     --flow-fail-line: #c25748;     --flow-fail-text: #f5b8ae;
    --flow-detail-text: #a09c90;
  }
}

:root[data-theme="dark"] {
  --paper: #121210;
  --surface: #1a1a17;
  --surface-2: #22221e;
  --surface-3: #2c2c27;
  --ink: #f2efe7;
  --ink-2: #b3afa4;
  --ink-3: #95917f;
  --rule: #47473d;
  --rule-2: #5b5b4f;
  --accent: #69cfbe;
  --accent-soft: #12302c;

  --ok: #63c98d;        --ok-soft: #14271c;
  --bad: #f78d7e;       --bad-soft: #2f1712;
  --warn: #e5b565;      --warn-soft: #2d2312;
  --skip: #b0aba0;      --skip-soft: #242420;
  --none: #8b877d;      --none-soft: #1f1f1b;

  --flow-bg: #1a1a17;
  --flow-line: #6d6a5f;
  --flow-shadow: rgba(0, 0, 0, 0.5);
  --flow-neutral-fill: #22221e;  --flow-neutral-line: #5f5c52;  --flow-neutral-text: #d5d1c6;
  --flow-action-fill: #1c2733;   --flow-action-line: #5b829e;   --flow-action-text: #b9cddb;
  --flow-helper-fill: #241f2b;   --flow-helper-line: #8a789e;   --flow-helper-text: #cfc3dc;
  --flow-assert-fill: #2c2413;   --flow-assert-line: #b99340;   --flow-assert-text: #ecd6a2;
  --flow-pass-fill: #14271c;     --flow-pass-line: #3f9c68;     --flow-pass-text: #a9e6c1;
  --flow-fail-fill: #2f1712;     --flow-fail-line: #c25748;     --flow-fail-text: #f5b8ae;
  --flow-detail-text: #a09c90;
}

/* One line per status; every dot, pill, chip, bar segment and matrix cell
   reads --st / --st-soft, so a status never needs its own component rule. */
.dot-passed, .pill-passed, .chip-passed, .bar-passed, .cell-passed { --st: var(--ok); --st-soft: var(--ok-soft); }
.dot-failed, .pill-failed, .chip-failed, .bar-failed, .cell-failed { --st: var(--bad); --st-soft: var(--bad-soft); }
.dot-interrupted, .pill-interrupted, .chip-interrupted, .bar-interrupted, .cell-interrupted { --st: var(--warn); --st-soft: var(--warn-soft); }
.dot-skipped, .pill-skipped, .chip-skipped, .bar-skipped, .cell-skipped { --st: var(--skip); --st-soft: var(--skip-soft); }
.dot-notrun, .pill-notrun, .chip-notrun, .bar-notrun, .cell-notrun { --st: var(--none); --st-soft: var(--none-soft); }
.dot-all, .chip-all { --st: var(--ink-2); --st-soft: var(--surface-2); }

* { box-sizing: border-box; }

html { scroll-behavior: smooth; scroll-padding-top: 84px; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 15px/1.6 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

h1, h2, h3, p, ol, ul, dl, figure, pre { margin-top: 0; }

/* Reading type. Anything a person reads in sentences gets the serif at reading
   size; everything else stays sans/mono chrome. */
.lede, .case-explainer, .notice p, .confidence-note, .coverage > .muted {
  font-family: var(--font-serif);
  font-size: var(--size-prose);
  line-height: var(--leading-prose);
}

a { color: var(--accent); text-underline-offset: 2px; }

code, kbd { font-family: var(--font-mono); font-size: 0.9em; }

.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip-link {
  position: absolute; left: 12px; top: -60px; z-index: 60;
  padding: 9px 14px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--rule-2);
  font-weight: 600; text-decoration: none;
  transition: top .16s ease;
}
.skip-link:focus { top: 12px; }

:where(a, button, input, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ---------------------------------------------------------------- topbar */

.topbar {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in srgb, var(--paper) 84%, transparent);
  backdrop-filter: saturate(1.4) blur(12px);
  -webkit-backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--rule);
}
.topbar-inner {
  display: flex; align-items: center; gap: 16px;
  width: min(1420px, 100% - 40px); margin: 0 auto;
  height: 56px;
}
.brand { display: flex; align-items: center; gap: 10px; flex: none; }
.brand-mark {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent);
}
.brand-text {
  display: flex; flex-direction: column; line-height: 1.15;
  font-family: var(--font-mono); font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
}
.brand-sub { color: var(--ink-3); font-size: 10px; letter-spacing: 0.11em; font-weight: 500; }

.topbar-now {
  flex: 1 1 auto; min-width: 0;
  color: var(--ink-2); font-size: 12.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transition: opacity .2s ease;
}
.topbar-now:not(:empty) { opacity: 1; }

.topbar-tools { display: flex; align-items: center; gap: 10px; flex: none; }
.run-chip {
  padding: 4px 9px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--rule);
  color: var(--ink-2); font-size: 11px; letter-spacing: 0.02em;
}

.theme-switch {
  display: inline-flex; padding: 2px; gap: 1px;
  background: var(--surface-2); border: 1px solid var(--rule);
  border-radius: 999px;
}
.theme-switch button {
  display: grid; place-items: center;
  width: 28px; height: 24px; padding: 0;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--ink-3); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.theme-switch button:hover { color: var(--ink); }
.theme-switch button[aria-checked="true"] {
  background: var(--surface); color: var(--accent);
  box-shadow: 0 1px 2px rgba(0,0,0,.12);
}
.theme-switch svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.5; }

/* ----------------------------------------------------------------- shell */

.shell {
  position: relative; z-index: 1;
  display: grid; grid-template-columns: 268px minmax(0, 1fr);
  gap: 34px;
  width: min(1420px, 100% - 40px); margin: 0 auto;
  align-items: start;
}
main { min-width: 0; padding: 40px 0 96px; }

/* ------------------------------------------------------------------ rail */

.rail { position: sticky; top: 56px; align-self: start; padding-top: 40px; }
.nav {
  max-height: calc(100vh - 112px);
  display: flex; flex-direction: column; gap: 12px;
  overflow: auto; overscroll-behavior: contain;
  padding-right: 6px;
}
.nav-search input {
  width: 100%; padding: 8px 11px;
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 9px;
  font: 400 13px var(--font-sans);
}
.nav-search input::placeholder { color: var(--ink-3); }

.filters { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px 4px 7px;
  background: transparent; border: 1px solid var(--rule);
  border-radius: 999px; color: var(--ink-2);
  font: 500 11.5px var(--font-sans); cursor: pointer;
  transition: border-color .15s ease, background .15s ease, color .15s ease;
}
.chip:hover { border-color: var(--rule-2); color: var(--ink); }
.chip[aria-pressed="true"] {
  background: var(--st-soft); border-color: color-mix(in srgb, var(--st) 45%, transparent);
  color: var(--ink);
}
.chip-dot, .nav-dot, .legend-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--st); flex: none;
}
.chip-count { color: var(--ink-3); font-family: var(--font-mono); font-size: 10.5px; }
.chip[aria-pressed="true"] .chip-count { color: var(--ink-2); }

.nav-count {
  margin: 0; color: var(--ink-3);
  font-family: var(--font-mono); font-size: var(--size-label);
  letter-spacing: var(--track-label);
}
.nav-actions { display: flex; gap: 6px; }
.nav-actions button {
  flex: 1; padding: 5px 8px;
  background: transparent; border: 1px solid var(--rule); border-radius: 7px;
  color: var(--ink-2); font: 500 11px var(--font-sans); cursor: pointer;
  transition: border-color .15s ease, color .15s ease;
}
.nav-actions button:hover { border-color: var(--rule-2); color: var(--ink); }

.nav-groups { display: flex; flex-direction: column; gap: 14px; }
.nav-group h3 {
  margin: 0 0 5px;
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); font-weight: 600; letter-spacing: var(--track-label);
}
.nav-group ol { list-style: none; margin: 0; padding: 0; }
.nav-group li { margin: 0; }
.nav-group a {
  display: grid; grid-template-columns: 7px 18px minmax(0, 1fr);
  align-items: baseline; gap: 8px;
  padding: 5px 8px 5px 6px; border-radius: 7px;
  color: var(--ink-2); text-decoration: none; font-size: 12.2px; line-height: 1.35;
  border-left: 2px solid transparent;
  transition: background .13s ease, color .13s ease;
}
.nav-group a .nav-dot { align-self: center; }
.nav-num { font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
.nav-label { overflow-wrap: anywhere; }
.nav-group a:hover { background: var(--surface-2); color: var(--ink); }
.nav-group a[aria-current="true"] {
  background: var(--surface); color: var(--ink);
  border-left-color: var(--accent); font-weight: 600;
}
.nav-empty { color: var(--ink-3); font-size: 12px; font-style: italic; }

/* -------------------------------------------------------------- masthead */

.masthead { margin-bottom: 44px; }
.eyebrow {
  margin-bottom: 12px; color: var(--accent);
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase;
}
h1 {
  margin-bottom: 16px;
  font-family: var(--font-serif); font-weight: 400;
  font-size: clamp(30px, 4.4vw, 44px); line-height: 1.1;
  letter-spacing: -0.012em; text-wrap: balance;
}
.lede {
  max-width: 66ch; margin-bottom: 30px; color: var(--ink-2);
}

/* --------------------------------------------------------------- verdict */

.verdict {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 30px; align-items: center;
  padding: 22px 0;
  border-top: 1px solid var(--rule-2);
  border-bottom: 1px solid var(--rule-2);
}
.verdict-figure { display: flex; flex-direction: column; gap: 3px; }
.verdict-ratio {
  font-family: var(--font-serif); font-size: 46px; line-height: 1;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
.verdict-ratio strong { font-weight: 400; color: var(--ink); }
.verdict-slash { margin: 0 2px; color: var(--ink-3); font-size: 34px; }
.verdict-caption {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.verdict-chart { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.bar {
  display: flex; gap: 2px; height: 12px;
  border-radius: 999px; overflow: hidden;
  background: var(--surface-3);
}
.bar-seg {
  background: var(--st); min-width: 4px;
  transition: flex-grow .4s cubic-bezier(.2,.7,.3,1);
}
.legend {
  display: flex; flex-wrap: wrap; gap: 4px 22px;
  list-style: none; margin: 0; padding: 0;
}
.legend-item { display: flex; align-items: baseline; gap: 7px; }
.legend-item .legend-dot { align-self: center; }
.legend-item.is-zero { opacity: 0.35; }
.legend-value {
  font-family: var(--font-mono); font-size: 15px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: var(--ink);
}
.legend-label {
  color: var(--ink-2); font-size: 11px;
  letter-spacing: 0.05em; text-transform: uppercase;
}

/* --------------------------------------------------------------- notices */

.notice {
  display: flex; gap: 14px; align-items: flex-start;
  margin-top: 18px; padding: 15px 18px;
  border: 1px solid color-mix(in srgb, var(--none) 40%, transparent);
  border-left-width: 3px;
  border-radius: var(--radius); background: var(--none-soft);
}
.notice p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-2); }
.notice p strong { color: var(--ink); }
.notice-badge {
  flex: none; padding: 3px 9px; border-radius: 999px;
  background: color-mix(in srgb, var(--none) 20%, transparent);
  color: var(--ink); font-family: var(--font-mono);
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  white-space: nowrap;
}

/* -------------------------------------------------------------- run meta */

.run-meta {
  display: flex; flex-wrap: wrap; gap: 0;
  margin: 22px 0 0; padding: 0;
  border-top: 1px solid var(--rule);
}
.run-meta div {
  display: flex; flex-direction: column; gap: 3px;
  padding: 12px 22px 12px 0; margin-right: 22px;
  border-right: 1px solid var(--rule);
}
.run-meta div:last-child { border-right: 0; margin-right: 0; }
dt {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); font-weight: 600; letter-spacing: var(--track-label);
}
dd { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }

/* ------------------------------------------------------- section heading */

.rule-heading {
  display: flex; align-items: baseline; gap: 12px;
  margin: 0 0 18px; padding-bottom: 9px;
  border-bottom: 1px solid var(--rule);
  font-family: var(--font-serif); font-weight: 400; font-size: 23px;
  letter-spacing: -0.01em;
}
.rule-heading span {
  margin-left: auto;
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
}

/* -------------------------------------------------------------- coverage */

.coverage { margin-bottom: 44px; }
.stat-row { display: flex; flex-wrap: wrap; gap: 0 44px; margin-bottom: 12px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-value {
  font-family: var(--font-serif); font-size: 32px; line-height: 1.05;
  font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
}
.stat-unit { color: var(--ink-3); font-size: 20px; }
.stat-label {
  color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.muted { color: var(--ink-2); font-size: 12.5px; max-width: 78ch; }

/* ---------------------------------------------------------------- matrix */

.matrix { margin-bottom: 48px; }
.matrix-groups { display: flex; flex-wrap: wrap; gap: 22px 32px; }
.matrix-group { display: flex; flex-direction: column; gap: 7px; }
.matrix-label {
  margin: 0; color: var(--ink-3); font-family: var(--font-mono);
  font-size: var(--size-label); letter-spacing: var(--track-label);
}
.matrix-cells { display: flex; flex-wrap: wrap; gap: 4px; max-width: 260px; }
.cell {
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 6px;
  background: var(--st-soft);
  border: 1px solid color-mix(in srgb, var(--st) 42%, transparent);
  color: var(--st); text-decoration: none;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  transition: transform .13s ease, box-shadow .13s ease;
}
.cell:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 10px -4px color-mix(in srgb, var(--st) 55%, transparent);
}
.cell-notrun { border-style: dashed; }

/* ------------------------------------------------------------ spec group */

.spec-group { margin-bottom: 34px; }
.spec-heading {
  display: flex; align-items: baseline; gap: 10px;
  margin: 0 0 12px;
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
}
.spec-heading::after {
  content: ""; flex: 1; height: 1px; background: var(--rule);
}
.spec-count { order: 3; color: var(--ink-3); font-weight: 500; }

/* ------------------------------------------------------------ case cards */

.case {
  margin-bottom: 0;
  border-top: 1px solid var(--rule);
  scroll-margin-top: 76px;
}
/* The status edge is an inset shadow rather than a border so it can sit on a
   borderless entry without shifting the text off the column. */
.case[data-status="failed"] { box-shadow: inset 3px 0 0 var(--bad); }
.case[data-status="interrupted"] { box-shadow: inset 3px 0 0 var(--warn); }
.case[data-status="notRun"] { color: var(--ink-2); }
.case[data-status="notRun"] .case-title { color: var(--ink-2); }
.case.is-target { border-color: var(--accent); }

.case-toggle {
  display: grid; grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center; gap: 14px; width: 100%;
  padding: 17px 18px 14px; border: 0; background: transparent;
  color: inherit; text-align: left; cursor: pointer; font: inherit;
}
.case-toggle:hover { background: var(--surface-2); }
.case-index {
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  color: var(--ink-3); font-variant-numeric: tabular-nums;
}
.case-headline { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.case-title {
  font-family: var(--font-serif); font-size: 20px; line-height: 1.3;
  letter-spacing: -0.004em; overflow-wrap: anywhere;
}
.case-subline {
  color: var(--ink-3); font-family: var(--font-mono); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.tag {
  padding: 1px 6px; border-radius: var(--radius);
  background: var(--surface-2); border: 1px solid var(--rule);
  color: var(--ink-3); font-family: var(--font-mono); font-size: 10.5px;
}
.case-head-right { display: flex; align-items: center; gap: 10px; flex: none; }
.case-duration {
  color: var(--ink-3); font-family: var(--font-mono); font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.case-chevron {
  width: 8px; height: 8px; border-right: 1.6px solid var(--ink-3); border-bottom: 1.6px solid var(--ink-3);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform .18s ease;
}
.case[data-open="false"] .case-chevron { transform: rotate(-45deg) translate(-2px, 2px); }
.case[data-open="false"] .case-body { display: none; }

.pill {
  display: inline-flex; align-items: center;
  padding: 3px 9px; border-radius: 999px;
  background: var(--st-soft); color: var(--st);
  border: 1px solid color-mix(in srgb, var(--st) 38%, transparent);
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase; white-space: nowrap;
}

.case-body { padding: 0 18px 26px; }

.facts {
  display: flex; flex-wrap: wrap; gap: 0;
  margin: 16px 0 14px;
}
.facts div {
  display: flex; flex-direction: column; gap: 3px;
  padding-right: 20px; margin-right: 20px;
  border-right: 1px solid var(--rule);
}
.facts div:last-child { border-right: 0; margin-right: 0; padding-right: 0; }

.case-explainer { margin-bottom: 16px; max-width: 74ch; font-size: 14px; }

.case-notrun {
  margin-bottom: 16px; padding: 11px 14px;
  border-left: 2px solid var(--none); border-radius: 0 8px 8px 0;
  background: var(--none-soft); color: var(--ink-2); font-size: 12.5px;
}

.strength {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid;
}
.strength-strong  { color: var(--ok);   background: var(--ok-soft);   border-color: color-mix(in srgb, var(--ok) 38%, transparent); }
.strength-solid   { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 38%, transparent); }
.strength-basic   { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 38%, transparent); }
.strength-shallow { color: var(--bad);  background: var(--bad-soft);  border-color: color-mix(in srgb, var(--bad) 38%, transparent); }

/* --------------------------------------------------------------- failure */

.failure {
  margin: 0 0 18px; padding: 14px 16px;
  background: var(--bad-soft);
  border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  border-left-width: 3px;
  border-radius: var(--radius);
}
.failure h3 {
  margin: 0 0 9px; color: var(--bad);
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}
.failure-message, .failure-snippet {
  margin: 0; padding: 10px 12px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 18%, transparent);
  border-radius: var(--radius);
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto;
}
.failure-snippet { margin-top: 8px; white-space: pre; overflow-wrap: normal; color: var(--ink-2); }

/* ------------------------------------------------------------ subsection */

.subsection { margin-top: 18px; }
.subsection h3 {
  margin-bottom: 9px; color: var(--ink-3);
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}
.flow-frame { margin: 0; }
.flow-frame svg {
  display: block; width: 100%; height: auto; max-height: 340px;
  background: var(--flow-bg);
  border: 1px solid var(--rule); border-radius: var(--radius);
}

.video-frame { margin: 0 0 12px; }
video {
  display: block; width: 100%; max-height: 520px;
  background: #05070a; border: 1px solid var(--rule); border-radius: 10px;
}
figcaption { margin-top: 6px; font-size: 12px; color: var(--ink-2); }

/* --------------------------------------------------------------- drawers */

.drawers { display: flex; flex-direction: column; gap: 0; margin-top: 18px; }
.drawer { border-top: 1px solid var(--rule); }
.drawer > summary {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 0; list-style: none; cursor: pointer; user-select: none;
  color: var(--ink-2); font-family: var(--font-mono);
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
}
.drawer > summary::-webkit-details-marker { display: none; }
.drawer > summary::before {
  content: ""; flex: none;
  width: 6px; height: 6px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform .18s ease;
}
.drawer[open] > summary::before { transform: rotate(45deg); }
.drawer > summary:hover { color: var(--ink); }
.drawer-body { padding-bottom: 14px; }

.implementations { margin-top: 34px; }
.implementations .drawer { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }

/* ---------------------------------------------------------------- checks */

.assertions { margin: 0; padding-left: 18px; }
.assertions li { margin: 9px 0; }
.confidence-note { margin-bottom: 10px; color: var(--ink-2); font-size: 13px; }
.quality {
  display: inline-flex; align-items: center;
  padding: 1px 7px; border-radius: 999px; border: 1px solid;
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase;
}
.quality-strict   { color: var(--ok);     background: var(--ok-soft);     border-color: color-mix(in srgb, var(--ok) 36%, transparent); }
.quality-moderate { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 36%, transparent); }
.quality-shallow  { color: var(--warn);   background: var(--warn-soft);   border-color: color-mix(in srgb, var(--warn) 36%, transparent); }
.quality-unknown  { color: var(--skip);   background: var(--skip-soft);   border-color: color-mix(in srgb, var(--skip) 36%, transparent); }

.assertions code, dd code {
  background: var(--surface-2); border: 1px solid var(--rule);
  border-radius: 4px; padding: 1px 4px; font-size: 11.5px;
}
.check-code { display: block; margin-top: 5px; }
.check-code > summary {
  display: inline-block; list-style: none; cursor: pointer;
  color: var(--ink-3); font-size: 11px;
}
.check-code > summary::-webkit-details-marker { display: none; }
.check-code > summary::before { content: "+ "; }
.check-code[open] > summary::before { content: "- "; }
.check-code code { display: inline-block; margin-top: 5px; }
.helper-ref { margin-top: 4px; color: var(--ink-3); font-size: 12px; }

/* ------------------------------------------------------------------ code */

.shiki, .fallback-code {
  border: 1px solid var(--rule); border-radius: var(--radius);
  overflow: auto; padding: 12px !important; margin: 0 !important;
  font-size: 12px; line-height: 1.6;
}
.shiki code, .fallback-code code { font-family: var(--font-mono); font-size: inherit; }
/* Shiki emits both palettes as custom properties (defaultColor:false), so the
   theme switch recolours the highlighted code with everything else. */
.shiki, .shiki span { color: var(--shiki-light); }
:root[data-theme="dark"] .shiki, :root[data-theme="dark"] .shiki span { color: var(--shiki-dark); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .shiki, :root:not([data-theme="light"]) .shiki span { color: var(--shiki-dark); }
}
/* Syntax colours come from shiki; the panel itself takes the report's surface so
   a code block doesn't punch a differently-tinted hole in the page. */
.shiki, .fallback-code { background: var(--surface-2) !important; }

.code-line { display: grid; grid-template-columns: 34px minmax(0, 1fr); min-width: max-content; }
.line-number { padding-right: 10px; color: var(--ink-3); text-align: right; user-select: none; opacity: .7; }
.line-source { white-space: pre; }
.code-line.is-highlighted {
  background: color-mix(in srgb, var(--warn) 20%, transparent) !important;
  box-shadow: inset 2px 0 0 var(--warn);
}

/* ----------------------------------------------------------------- misc. */

.report-foot {
  display: flex; flex-direction: column; gap: 4px;
  margin-top: 48px; padding-top: 18px;
  border-top: 1px solid var(--rule);
  color: var(--ink-3); font-size: 12px;
}

.to-top {
  position: fixed; right: 22px; bottom: 22px; z-index: 30;
  width: 38px; height: 38px; padding: 0;
  display: grid; place-items: center;
  background: var(--surface); color: var(--ink-2);
  border: 1px solid var(--rule-2); border-radius: 50%;
  cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
  transform: translateY(6px);
}
.to-top::before {
  content: ""; width: 8px; height: 8px;
  border-left: 1.6px solid currentColor; border-top: 1.6px solid currentColor;
  transform: rotate(45deg) translate(1px, 1px);
}
.to-top.is-visible { opacity: 1; pointer-events: auto; transform: none; }
.to-top:hover { color: var(--accent); border-color: var(--accent); }

.is-hidden { display: none !important; }

/* --------------------------------------------------------------- motion */

@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.masthead > *, .coverage, .matrix { animation: rise .5s cubic-bezier(.2,.7,.3,1) both; }
.masthead > *:nth-child(2) { animation-delay: .04s; }
.masthead > *:nth-child(3) { animation-delay: .08s; }
.masthead > *:nth-child(4) { animation-delay: .12s; }
.masthead > *:nth-child(5) { animation-delay: .16s; }
.coverage { animation-delay: .18s; }
.matrix { animation-delay: .22s; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* ------------------------------------------------------------ responsive */

@media (max-width: 1080px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .rail {
    position: static; padding-top: 24px;
    border-bottom: 1px solid var(--rule); padding-bottom: 20px;
  }
  .nav { max-height: none; overflow: visible; }
  .nav-groups { display: none; }
  main { padding-top: 28px; }
}

@media (max-width: 720px) {
  .topbar-inner, .shell { width: min(100%, 100% - 24px); }
  .topbar-now { display: none; }
  .verdict { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .run-meta div { border-right: 0; margin-right: 0; padding: 8px 0; }
  .facts div { border-right: 0; margin-right: 0; padding: 6px 0; }
  .case-toggle { grid-template-columns: 24px minmax(0, 1fr); row-gap: 8px; }
  .case-head-right { grid-column: 2; justify-content: flex-start; }
  .matrix-cells { max-width: none; }
}

/* ----------------------------------------------------------------- print */

@media print {
  :root { --paper: #fff; --surface: #fff; }
  .topbar, .rail, .to-top, .skip-link { display: none !important; }
  .shell { display: block; width: 100%; }
  main { padding: 0; }
  .case { break-inside: avoid; }
  .case[data-open="false"] .case-body { display: block !important; }
  .drawer > summary { display: none; }
  .drawer-body { display: block !important; }
  .is-hidden { display: block !important; }
}`

const ASSERTION_HTML_SCRIPT = `
/* Theme switch: light / system / dark, persisted per reader. The document
   renders correctly with none of this running — the OS media query already
   picked a palette and every case is expanded in the markup. */
;(() => {
  const KEY = 'canary-evaluation-theme'
  const root = document.documentElement
  const buttons = [...document.querySelectorAll('[data-theme-set]')]
  if (!buttons.length) return
  const read = () => {
    try { return localStorage.getItem(KEY) || 'auto' } catch (err) { return 'auto' }
  }
  const paint = (mode) => {
    if (mode === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', mode)
    for (const button of buttons) {
      button.setAttribute('aria-checked', String(button.dataset.themeSet === mode))
    }
  }
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeSet
      try {
        if (mode === 'auto') localStorage.removeItem(KEY)
        else localStorage.setItem(KEY, mode)
      } catch (err) { /* storage blocked — the switch still works for this session */ }
      paint(mode)
    })
  }
  paint(read())
})()

/* Expand / collapse. The markup ships expanded so a JS-less reader sees
   everything; on load we fold away the cases that carry no news — passing,
   skipped and never-run — and leave failures open. */
;(() => {
  const cases = [...document.querySelectorAll('.case')]
  if (!cases.length) return
  const setOpen = (node, open) => {
    node.dataset.open = String(open)
    const toggle = node.querySelector('.case-toggle')
    if (toggle) toggle.setAttribute('aria-expanded', String(open))
  }
  for (const node of cases) {
    const noteworthy = node.dataset.status === 'failed' || node.dataset.status === 'interrupted'
    setOpen(node, noteworthy)
    const toggle = node.querySelector('.case-toggle')
    if (toggle) toggle.addEventListener('click', () => setOpen(node, node.dataset.open !== 'true'))
  }
  const all = (open) => { for (const node of cases) setOpen(node, open) }
  document.querySelector('[data-expand-all]')?.addEventListener('click', () => all(true))
  document.querySelector('[data-collapse-all]')?.addEventListener('click', () => all(false))
  // A deep link should land on an open case, however the reader got there.
  const openTarget = () => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (!id) return
    const node = document.getElementById(id)?.closest('.case')
    if (node) setOpen(node, true)
  }
  window.addEventListener('hashchange', openTarget)
  openTarget()
  // Print with everything visible — a folded report prints as a list of titles.
  window.addEventListener('beforeprint', () => all(true))
})()

/* Filter + search. Hides cases, their nav entries and their matrix cells
   together, so the three views never disagree about what is on screen. */
;(() => {
  const cases = [...document.querySelectorAll('.case')]
  const chips = [...document.querySelectorAll('[data-filter]')]
  const search = document.getElementById('case-search')
  const count = document.querySelector('[data-nav-count]')
  const empty = document.querySelector('[data-nav-empty]')
  if (!cases.length) return
  const navItems = new Map()
  for (const item of document.querySelectorAll('[data-nav-item]')) {
    const id = item.querySelector('a')?.dataset.sectionId
    if (id) navItems.set(id, item)
  }
  const cells = new Map()
  for (const cell of document.querySelectorAll('[data-matrix-cell]')) {
    cells.set(decodeURIComponent(cell.getAttribute('href').slice(1)), cell)
  }
  let status = 'all'
  let term = ''
  const apply = () => {
    let shown = 0
    for (const node of cases) {
      const matches = (status === 'all' || node.dataset.status === status)
        && (!term || (node.dataset.search || '').includes(term))
      node.classList.toggle('is-hidden', !matches)
      navItems.get(node.id)?.classList.toggle('is-hidden', !matches)
      cells.get(node.id)?.classList.toggle('is-hidden', !matches)
      if (matches) shown += 1
    }
    // A group whose every child is filtered out is noise, not structure.
    for (const group of document.querySelectorAll('[data-group], [data-nav-group]')) {
      const children = [...group.querySelectorAll('.case, [data-nav-item]')]
      group.classList.toggle('is-hidden', children.length > 0 && children.every((child) => child.classList.contains('is-hidden')))
    }
    if (count) count.textContent = shown + ' of ' + cases.length + ' shown'
    if (empty) empty.hidden = shown !== 0
  }
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      status = chip.dataset.filter === status ? 'all' : chip.dataset.filter
      for (const other of chips) other.setAttribute('aria-pressed', String(other.dataset.filter === status))
      apply()
    })
  }
  search?.addEventListener('input', () => {
    term = search.value.trim().toLowerCase()
    apply()
  })
  apply()
})()

/* Scroll spy: highlights the nav entry for the case in view and mirrors its
   title into the sticky top bar, so the reader always knows where they are. */
;(() => {
  const links = [...document.querySelectorAll('.nav a[data-section-id]')]
  const now = document.querySelector('[data-topbar-now]')
  const sections = links.map((link) => document.getElementById(link.dataset.sectionId)).filter(Boolean)
  if (!links.length || !sections.length || !('IntersectionObserver' in window)) return
  const setActive = (id) => {
    for (const link of links) {
      const active = link.dataset.sectionId === id
      if (active) {
        link.setAttribute('aria-current', 'true')
        if (now) now.textContent = link.querySelector('.nav-label')?.textContent || ''
      } else {
        link.removeAttribute('aria-current')
      }
    }
  }
  const visible = new Set()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    const active = [...visible]
      .map((el) => ({ id: el.id, top: el.getBoundingClientRect().top }))
      .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0]
    if (active) setActive(active.id)
    else if (now && !visible.size && window.scrollY < 200) now.textContent = ''
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 })
  for (const section of sections) observer.observe(section)
  if (location.hash) setActive(decodeURIComponent(location.hash.slice(1)))
})()

/* Back to top. */
;(() => {
  const button = document.querySelector('[data-to-top]')
  if (!button) return
  button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
  const sync = () => button.classList.toggle('is-visible', window.scrollY > 600)
  window.addEventListener('scroll', sync, { passive: true })
  sync()
})()

/* Flow node ↔ source line. Hovering a step in the diagram opens the test code
   and highlights the statement it came from. */
;(() => {
  const clear = (testCase) => {
    testCase.querySelectorAll('.flow-node.is-active, .code-line.is-highlighted').forEach((el) => {
      el.classList.remove(el.classList.contains('flow-node') ? 'is-active' : 'is-highlighted')
    })
  }
  const activate = (node) => {
    const testCase = node.closest('.case')
    if (!testCase) return
    clear(testCase)
    const line = node.getAttribute('data-code-line')
    if (!line) return
    node.classList.add('is-active')
    const details = testCase.querySelector('.test-code-details')
    if (details) details.open = true
    testCase.querySelectorAll('.code-line[data-code-line="' + line.replace(/"/g, '') + '"]').forEach((el) => {
      el.classList.add('is-highlighted')
    })
  }
  document.querySelectorAll('.flow-node[data-code-line]').forEach((node) => {
    node.addEventListener('mouseenter', () => activate(node))
    node.addEventListener('focus', () => activate(node))
    node.addEventListener('mouseleave', () => {
      const testCase = node.closest('.case')
      if (testCase) clear(testCase)
    })
  })
})()`

function playbackTests(events: PlaywrightPlaybackEvent[]): Array<{
  name: string
  title: string
  location: string
  status: string
  durationMs?: number
  error?: { message: string; snippet?: string }
}> {
  // One entry per (name, location). Retries and heal-cycle reruns share both
  // and fold into the latest test-end. Two distinct tests that share a title
  // (and therefore a name, since name = `test-case-${slugify(title)}`) but
  // live at different locations stay separate — the HTML export disambiguates
  // them via positional anchor IDs. Map preserves first-seen insertion order.
  const latest = new Map<string, { name: string; title: string; location: string; status: string; durationMs?: number; error?: { message: string; snippet?: string } }>()
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const key = `${event.test.name}@${event.test.location}`
    latest.set(key, {
      name: event.test.name,
      title: event.test.title,
      location: event.test.location,
      status: event.status,
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error } : {}),
    })
  }
  return [...latest.values()]
}

function listSpecFiles(featureDir: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:spec|test)\.[tj]sx?$/.test(entry.name)) out.push(full)
    }
  }
  visit(featureDir)
  return out.sort()
}

function sourceKey(location: string): string {
  const match = location.match(/^(.*):(\d+)(?::\d+)?$/)
  return match ? `${match[1]}:${match[2]}` : location
}

function isPlaywrightTestCall(node: ts.CallExpression): boolean {
  const chain = calleeChain(node.expression)
  if (chain[0] !== 'test') return false
  if (chain[1] === 'describe' || chain[1] === 'step') return false
  return chain.length >= 1
}

function isAssertionCall(node: ts.CallExpression): boolean {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  return idx >= 0 && idx < chain.length - 1
}

function isWaitAssertionCall(node: ts.CallExpression): boolean {
  return matcherName(node)?.toLowerCase() === 'waitforurl'
}

function matcherName(node: ts.CallExpression): string | undefined {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  if (idx >= 0 && idx < chain.length - 1) return chain[chain.length - 1]
  const last = chain.at(-1)
  return last?.startsWith('waitFor') ? last : undefined
}

function calleeChain(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr)) return [...calleeChain(expr.expression), expr.name.text]
  if (ts.isCallExpression(expr)) return calleeChain(expr.expression)
  return []
}

function calledIdentifier(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

function stringArg(node: ts.CallExpression, src: ts.SourceFile): string | undefined {
  const arg = node.arguments[0]
  if (!arg) return undefined
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) return arg.getText(src).slice(1, -1)
  return undefined
}

function functionBody(node: ts.CallExpression): ts.ConciseBody | undefined {
  // Playwright accepts both test(title, body) and test(title, details, body),
  // where the 3-arg form carries a { tag, annotation } object — exactly what the
  // coverage annotator (tag-writer.ts) inserts after the title. That shifts the
  // callback to the last argument, so scan from the end rather than assuming
  // arguments[1], or every tag-annotated test reads as "Source unavailable".
  for (let i = node.arguments.length - 1; i >= 1; i -= 1) {
    const arg = node.arguments[i]
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  }
  return undefined
}

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0]
    if (decl && ts.isIdentifier(decl.name)) return decl.name.text
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

function functionLikeBody(node: ts.Node): ts.ConciseBody | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.body
  if (ts.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  return undefined
}

function lineFor(node: ts.Node, src: ts.SourceFile): number {
  return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function cleanSnippet(input: string): string {
  return input.replace(/\r\n/g, '\n').trim()
}

function inline(input: string): string {
  return input.replace(/\s+/g, ' ').replace(/`/g, '\\`').slice(0, 220)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// HTML anchor ids must be unique within a document, so a repeat sanitises to
// `<base>-2`, `<base>-3`, … The one production caller prefixes each value with
// its 1-based index, which means it can never hit the suffix loop or the empty
// fallback — both are part of this helper's contract rather than dead code, and
// are pinned by direct tests through the internals seam.
function uniqueSectionIds(values: string[]): string[] {
  const used = new Set<string>()
  return values.map((value) => {
    const base = safeFilename(value)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    used.add(candidate)
    return candidate
  })
}

function safeFilename(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

function titleCaseFeatureName(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-zA-Z]/g, (char) => char.toUpperCase())
}

function dedupeAssertions(assertions: TestReviewAssertion[]): TestReviewAssertion[] {
  const seen = new Set<string>()
  return assertions.filter((assertion) => {
    const key = `${assertion.kind}:${assertion.snippet}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
  const seen = new Set<string>()
  return helpers.filter((helper) => {
    const key = `${helper.file}:${helper.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function flattenHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
  const out: HelperDefinition[] = []
  const seen = new Set<string>()
  const visit = (helper: HelperDefinition): void => {
    const key = `${helper.file}:${helper.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(helper)
    for (const dependency of helper.dependencies) visit(dependency)
  }
  for (const helper of helpers) visit(helper)
  return out
}

function strongestQuality(assertions: TestReviewAssertion[]): AssertionQuality {
  const rank: Record<AssertionQuality, number> = { unknown: 0, shallow: 1, moderate: 2, strict: 3 }
  return assertions.reduce<AssertionQuality>((best, assertion) =>
    rank[assertion.quality] > rank[best] ? assertion.quality : best, 'unknown')
}

function qualitySummary(assertions: TestReviewAssertion[]): string {
  const counts = new Map<AssertionQuality, number>()
  for (const assertion of assertions) counts.set(assertion.quality, (counts.get(assertion.quality) ?? 0) + 1)
  return (['strict', 'moderate', 'shallow', 'unknown'] as const)
    .flatMap((quality) => counts.has(quality) ? [`${counts.get(quality)} ${quality}`] : [])
    .join(', ')
}

function qualitySummaryForAudience(assertions: TestReviewAssertion[]): string {
  const counts = new Map<AssertionQuality, number>()
  for (const assertion of assertions) counts.set(assertion.quality, (counts.get(assertion.quality) ?? 0) + 1)
  return (['strict', 'moderate', 'shallow', 'unknown'] as const)
    .flatMap((quality) => counts.has(quality) ? [`${counts.get(quality)} ${qualityLabel(quality)}`] : [])
    .join(', ')
}

function unknownAssertion(rationale: string): TestReviewAssertion {
  return {
    kind: 'direct',
    label: 'unknown',
    quality: 'unknown',
    rationale,
    snippet: '',
  }
}

function isNoiseHelper(name: string): boolean {
  return ['test', 'describe', 'beforeEach', 'afterEach'].includes(name)
}

function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
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
