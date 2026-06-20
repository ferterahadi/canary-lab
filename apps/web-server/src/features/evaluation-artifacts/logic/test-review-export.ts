import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { codeToHtml } from 'shiki'
import ts from 'typescript'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../orchestration/logic/run-store'
import { pickAvailableHealAgent, type HealAgent } from '../../orchestration/logic/runtime/auto-heal'
import { EVALUATION_REWRITE_MODELS, modelArgs, modelFor } from '../../agent-management/logic/agent-models'
import { claudeSessionLogPath } from '../../agent-management/logic/agent-session-log'
import { recoverClaudeFinalText } from '../../agent-management/logic/agent-stream'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../agent-management/logic/agent-process'
import { formatCodeForDisplay } from '../../../../../../shared/code-display-format'

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
}

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

interface TocItem {
  level: 1 | 2 | 3
  id: string
  label: string
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
  const rewrite = normalizeEvaluationRewrite(options.rewrite ?? options.narrative, packet) ?? deterministicEvaluationRewrite(packet)
  const flowcharts = createFlowcharts(packet, rewrite)
  return renderHtml(packet, { ...options, rewrite }, flowcharts)
}

export async function createAssertionExport(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<AssertionExport> {
  return createEvaluationExport(detail, options)
}

export async function createEvaluationExport(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<AssertionExport> {
  const packet = buildTestReviewPacket(detail)
  const rewrite = normalizeEvaluationRewrite(options.rewrite ?? options.narrative, packet) ?? deterministicEvaluationRewrite(packet)
  const flowcharts = createFlowcharts(packet, rewrite)
  return {
    html: await renderHtml(packet, { ...options, rewrite }, flowcharts),
    assets: [],
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
    },
    tests: input.packet.tests.map((test) => ({
      title: test.title,
      status: test.status,
      checkStrength: qualitySummaryForAudience(test.assertions),
      flowSteps: input.flowcharts.find((flowchart) => flowchart.testName === test.name)?.steps ?? [],
      failureMessages: test.status === 'passed' ? [] : test.assertions.map((assertion) => assertion.rationale),
    })),
  }
  return renderPromptTemplate(loadEvaluationRewriteTemplate(input.templatePath), {
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

const EVALUATION_REWRITE_TEMPLATE_PATH = path.join(__dirname, '../../../../prompts/evaluation-rewrite.md')
const EVALUATION_REWRITE_SCHEMA_PATH = path.join(__dirname, '../../../../prompts/evaluation-rewrite.schema.json')
function loadEvaluationRewriteTemplate(templatePath: string = EVALUATION_REWRITE_TEMPLATE_PATH): string {
  return fs.readFileSync(templatePath, 'utf-8').trim()
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

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
    activityPath: agent === 'claude' && claudeSessionId && cwd ? claudeSessionLogPath(cwd, claudeSessionId) : undefined,
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
        let finalOutput = agent === 'claude' ? recoverClaudeFinalText(stdout) : stdout
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
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const text = (fenced ?? output).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as EvaluationRewrite
  } catch {
    return undefined
  }
}

function parseEvaluationTextSlotRewrite(output: string): EvaluationTextSlot[] | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const text = (fenced ?? output).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { slots?: unknown }
    if (!Array.isArray(parsed.slots)) return undefined
    const slots = parsed.slots.flatMap((slot): EvaluationTextSlot[] => {
      if (!slot || typeof slot !== 'object') return []
      const item = slot as Partial<EvaluationTextSlot>
      if (typeof item.id !== 'string' || typeof item.text !== 'string') return []
      return [{ id: item.id, text: item.text }]
    })
    return slots.length ? slots : undefined
  } catch {
    return undefined
  }
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
  const tests = eventTests.map((eventTest) => {
    const source = sourceTests.get(sourceKey(eventTest.location))
    return {
      name: eventTest.name,
      title: eventTest.title,
      status: eventTest.status,
      ...(typeof eventTest.durationMs === 'number' ? { durationMs: eventTest.durationMs } : {}),
      testBody: source?.bodySource ?? '',
      helperCalls: source?.helperCalls ?? [],
      helperDefinitions: source?.helperDefinitions ?? [],
      externalImports: source?.externalImports ?? [],
      assertions: source?.assertions.length
        ? source.assertions
        : [unknownAssertion('No static assertion detected in the matched test body.')],
    }
  })

  for (const passedName of detail.summary?.passedNames ?? []) {
    if (tests.some((test) => slugFromTitle(test.title) === passedName || test.title === passedName)) continue
    tests.push({
      title: passedName,
      name: passedName,
      status: 'passed',
      testBody: '',
      helperCalls: [],
      helperDefinitions: [],
      externalImports: [],
      assertions: [unknownAssertion('No playback event or source match was available for this passed test.')],
    })
  }

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
        if (name && !isPlaywrightTestCall(node) && !isNoiseHelper(name)) {
          helperCalls.push(cleanSnippet(node.getText(src)))
          const helper = helperFor(name)
          if (helper) helperDefinitions.push(helper)
        }
        if (name?.startsWith('expect')) {
          const helper = helperFor(name)
          assertions.push(helperAssertion(node, src, helper))
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

function classifyAssertion(snippet: string, matcher?: string): AssertionQuality {
  const text = snippet.toLowerCase()
  const strictMatchers = new Set([
    'tohavetext',
    'tocontaintext',
    'tohaveurl',
    'tohavevalue',
    'tohaveattribute',
    'tohavecount',
    'tobechecked',
    'tobedisabled',
    'tobeenabled',
    'waitforurl',
    'toequal',
    'tostrictEqual'.toLowerCase(),
    'tobe',
  ])
  if (matcher && strictMatchers.has(matcher.toLowerCase())) return 'strict'
  if (/thank|success|error|expired|redeemed|not\s+found|cannot|reject|order|voucher|url|toast/.test(text)) return 'strict'
  if (matcher && ['tobevisible', 'tobehidden', 'toBeAttached'.toLowerCase()].includes(matcher.toLowerCase())) return 'moderate'
  if (/visible|hidden|attached|enabled|disabled/.test(text)) return 'moderate'
  if (/count|length|exist|present/.test(text)) return 'shallow'
  return 'unknown'
}

function rationaleFor(quality: AssertionQuality, snippet: string, matcher?: string): string {
  if (quality === 'strict') {
    return `Uses ${matcher} against concrete expected behavior or copy.`
  }
  if (quality === 'moderate') return 'Checks a meaningful UI condition, but the static evidence is indirect.'
  if (quality === 'shallow') return 'Checks weak existence or quantity evidence without proving the business outcome.'
  return 'Static analysis could not confidently classify this assertion.'
}

export function deterministicEvaluationRewrite(packet: TestReviewPacket): EvaluationRewrite {
  const feature = titleCaseFeatureName(packet.feature)
  const result = `${packet.passed}/${packet.total} checks passed`
  return {
    featureTitle: feature,
    summary: packet.failed > 0
      ? `${feature} was evaluated with ${packet.tests.length} scenarios. ${result}, so review the failed scenarios before treating this behavior as ready.`
      : `${feature} was evaluated with ${packet.tests.length} scenarios. ${result}, so the tested behavior matched the expected outcomes for this run.`,
    cases: packet.tests.map((test) => {
      const title = audienceTitle(test.title)
      return {
        title,
        whatWasChecked: `This scenario checks whether "${title}" behaves as expected.`,
        whyItMatters: test.status === 'passed'
          ? 'This matters because it shows the covered user or business path worked during this run.'
          : 'This matters because a failed scenario may point to behavior that users or operations teams could experience.',
        confidence: confidenceForAssertions(test.assertions),
        flowSteps: flowNodesForTest(test).map((node) => ({
          title: audienceFlowTitle(node, test),
          ...(node.detail ? { detail: audienceFlowDetail(node.detail) } : {}),
        })),
      }
    }),
  }
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
      return humanizeIdentifier(match)
    })
    .replace(/\s*-\s*>|\s*→\s*/g, ' then ')
    .replace(/\s+/g, ' ')
    .trim()
  return sentenceCase(cleaned)
}

function audienceFlowTitle(node: FlowNode, test: TestReviewCase): string {
  if (node.kind === 'start') return 'Start the scenario'
  if (node.kind === 'end') return node.title.replace(/^Result:/, 'Run result:')
  if (node.kind === 'assertion') return 'Check the expected outcome'
  if (node.kind === 'helper') {
    const helperName = node.title.replace(/^Helper:\s*/, '')
    return readableActionName(helperName, node.detail ?? helperName) || readableHelperName(helperName) || 'Run a shared test step'
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
    .replace(/\bstrict\b/gi, 'strong')
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

async function renderHtml(packet: TestReviewPacket, options: AssertionHtmlOptions, flowcharts: TestFlowchart[]): Promise<string> {
  const rewrite = normalizeEvaluationRewrite(options.rewrite ?? options.narrative, packet) ?? deterministicEvaluationRewrite(packet)
  const displayFeature = rewrite.featureTitle?.trim() || titleCaseFeatureName(packet.feature)
  const testIds = uniqueSectionIds(packet.tests.map((test, idx) => `${idx + 1}-${test.title}`))
  const flowchartByTestName = new Map(flowcharts.map((flowchart) => [flowchart.testName, flowchart]))
  const implementationId = 'local-codebase-implementations'
  const tocItems: TocItem[] = [
    { level: 1, id: 'evaluation-report', label: displayFeature },
    { level: 2, id: 'test-cases', label: 'Test Cases' },
    ...rewrite.cases.map((test, idx) => ({ level: 3 as const, id: testIds[idx], label: `${idx + 1}. ${test.title}` })),
  ]
  const externalImports = dedupe(packet.tests.flatMap((test) => test.externalImports)).sort()
  const helpers = flattenHelpers(packet.tests.flatMap((test) => test.helperDefinitions))
  if (externalImports.length || helpers.length) tocItems.push({ level: 2, id: implementationId, label: 'Helper functions used' })

  const testSections = await Promise.all(packet.tests.map(async (test, idx) => {
    const videoLinks = options.videoLinksByTestName?.[test.name] ?? []
    const flowchart = flowchartByTestName.get(test.name)
    const audienceCase = rewrite.cases[idx]
    return `
      <section class="test-case" id="${escapeAttr(testIds[idx])}">
        <h2>${idx + 1}. ${escapeHtml(audienceCase.title)}</h2>
        <dl class="case-meta">
          <div><dt>Result</dt><dd><span class="status status-${escapeAttr(statusClass(test.status))}">${escapeHtml(test.status)}</span>${typeof test.durationMs === 'number' ? ` <span class="muted">(${escapeHtml(formatMs(test.durationMs))})</span>` : ''}</dd></div>
          <div><dt>Check strength</dt><dd>${escapeHtml(qualitySummaryForAudience(test.assertions))}</dd></div>
        </dl>
        <p class="case-explainer">${escapeHtml(audienceCase.whatWasChecked)}</p>
        ${flowchart ? renderFlowchartSection(flowchart, audienceCase.title) : ''}
        <details class="test-code-details">
          <summary>Test code</summary>
          ${test.testBody ? await renderTestCode(test.testBody) : '<p class="muted">Source unavailable.</p>'}
        </details>
        <details class="checks-details">
          <summary>Checks</summary>
          <p class="confidence-note">${escapeHtml(audienceCase.confidence)}</p>
          <ul class="assertions">${test.assertions.map(renderAssertionHtml).join('')}</ul>
        </details>
        ${videoLinks.length ? renderVideoSection(videoLinks) : ''}
      </section>
    `
  }))

  const implementations = await renderImplementations(externalImports, helpers, implementationId)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Evaluation Report: ${escapeHtml(displayFeature)}</title>
  <style>${ASSERTION_HTML_CSS}</style>
</head>
<body>
  <div class="page-shell">
    ${renderToc(tocItems)}
    <main>
      <header class="page-header">
        <p class="eyebrow">Test Results</p>
        <h1 id="evaluation-report">${escapeHtml(displayFeature)}</h1>
        <p class="report-summary">${escapeHtml(rewrite.summary)}</p>
        <div class="summary-strip">
          <div><span class="summary-value">${packet.passed}/${packet.total}</span><span class="summary-label">passed</span></div>
          <div><span class="summary-value">${escapeHtml(packet.status)}</span><span class="summary-label">run status</span></div>
          <div><span class="summary-value">${packet.tests.length}</span><span class="summary-label">test cases</span></div>
        </div>
        <dl class="run-meta">
          <div><dt>Run</dt><dd><code>${escapeHtml(packet.runId)}</code></dd></div>
          <div><dt>Status</dt><dd><span class="status status-${escapeAttr(statusClass(packet.status))}">${escapeHtml(packet.status)}</span></dd></div>
          <div><dt>Result</dt><dd>${packet.passed}/${packet.total} passed</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(packet.startedAt)}</dd></div>
          ${packet.endedAt ? `<div><dt>Ended</dt><dd>${escapeHtml(packet.endedAt)}</dd></div>` : ''}
        </dl>
      </header>
      <section aria-labelledby="test-cases" id="test-cases">
        <h2 class="section-title">Test Cases</h2>
        ${testSections.join('')}
      </section>
      ${implementations}
    </main>
  </div>
  <script>${ASSERTION_HTML_SCRIPT}</script>
</body>
</html>
`
}

function renderToc(items: TocItem[]): string {
  return `<nav class="toc" aria-label="Table of contents">
    <h2>Contents</h2>
    <ol>
      ${items.map((item, idx) => `<li class="toc-level-${item.level}"><a href="#${escapeAttr(item.id)}" data-section-id="${escapeAttr(item.id)}"${idx === 0 ? ' aria-current="true"' : ''}>${escapeHtml(item.label)}</a></li>`).join('')}
    </ol>
  </nav>`
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
    <details>
      <summary><span class="section-title">Helper functions used</span></summary>
      ${await highlightCode(source)}
    </details>
  </section>`
}

function createFlowcharts(packet: TestReviewPacket, rewrite: EvaluationRewrite): TestFlowchart[] {
  return packet.tests.map((test, idx) => {
    const steps = applyFlowStepRewrite(flowNodesForTest(test), rewrite.cases[idx]?.flowSteps)
    return {
      testName: test.name,
      steps,
      svg: renderFlowchartSvg(steps, rewrite.cases[idx]?.title ?? test.title),
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

function flowNodesForTest(test: TestReviewCase): FlowNode[] {
  if (!test.testBody) {
    return [
      { kind: 'start', title: test.title },
      { kind: 'setup', title: 'Source unavailable', detail: qualitySummary(test.assertions) || 'No static source match' },
      { kind: 'end', title: `Result: ${test.status}` },
    ]
  }
  return [
    { kind: 'start', title: test.title },
    ...testBodyStatements(test).map((statement) => flowNodeForStatement(statement.text, test, statement.line)),
    { kind: 'end', title: `Result: ${test.status}` },
  ]
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
  return fn.body.statements.map((statement) => ({
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

function renderFlowchartSvg(nodes: FlowNode[], title: string): string {
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
  const colors: Record<FlowNode['kind'], { fill: string; stroke: string; text: string }> = {
    start: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
    setup: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
    action: { fill: '#eff6ff', stroke: '#2563eb', text: '#1e3a8a' },
    helper: { fill: '#faf5ff', stroke: '#7c3aed', text: '#4c1d95' },
    assertion: { fill: '#fffbeb', stroke: '#d97706', text: '#78350f' },
    end: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
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
        ? `<path class="connector" d="M${x + nodeWidth + 10} ${y + nodeHeight / 2} L${x + nodeWidth + gap - 12} ${y + nodeHeight / 2}" marker-end="url(#arrow)" />`
        : `<path class="connector" d="M${x + nodeWidth / 2} ${y + nodeHeight + 10} C${x + nodeWidth / 2} ${y + 124}, ${startX + nodeWidth / 2} ${startY + next.row * rowHeight - 22}, ${startX + nodeWidth / 2} ${startY + next.row * rowHeight - 8}" marker-end="url(#arrow)" />`
      : ''
    const codeAttr = typeof node.codeLine === 'number' ? ` data-code-line="${node.codeLine}" tabindex="0"` : ''
    return `<g class="flow-node"${codeAttr}>
      <title>${escapeHtml(node.detail ? `${node.title}: ${node.detail}` : node.title)}</title>
      ${nodeShape(node.kind, x, y, nodeWidth, nodeHeight, color.fill, color.stroke)}
      ${text}
      ${arrow}
    </g>`
  }).join('\n')
  return `<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evaluation flow for ${escapeAttr(title)}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L7,3 z" fill="#64748b" />
    </marker>
    <filter id="nodeShadow" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#0f172a" flood-opacity="0.10" />
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="#ffffff" />
  <style>.connector{fill:none;stroke:#64748b;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.flow-node{cursor:pointer}.flow-node:focus{outline:none}.flow-node.is-active rect,.flow-node.is-active polygon,.flow-node.is-active path{stroke-width:3}</style>
  <style>text{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>
  ${body}
</svg>
`
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
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${detailSize}" fill="#475569">${escapeHtml(line)}</text>`
    cursor += detailGap
    return out
  })
  return [...title, ...detail].join('')
}

function resultColor(title: string): { fill: string; stroke: string; text: string } {
  const normalized = title.toLowerCase()
  if (normalized.includes('passed') || normalized.includes('succeed') || normalized.includes('success')) {
    return { fill: '#ecfdf5', stroke: '#16a34a', text: '#14532d' }
  }
  if (normalized.includes('failed') || normalized.includes('fail')) {
    return { fill: '#fff1f2', stroke: '#e11d48', text: '#881337' }
  }
  return { fill: '#f8fafc', stroke: '#64748b', text: '#334155' }
}

function nodeShape(kind: FlowNode['kind'], x: number, y: number, width: number, height: number, fill: string, stroke: string): string {
  if (kind === 'assertion') {
    const points = [
      `${x + 18},${y}`,
      `${x + width - 18},${y}`,
      `${x + width},${y + height / 2}`,
      `${x + width - 18},${y + height}`,
      `${x + 18},${y + height}`,
      `${x},${y + height / 2}`,
    ].join(' ')
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'start' || kind === 'end') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'setup') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'helper') {
    return `<path d="M${x} ${y + 10} Q${x} ${y} ${x + 10} ${y} H${x + width - 10} Q${x + width} ${y} ${x + width} ${y + 10} V${y + height - 10} Q${x + width} ${y + height} ${x + width - 10} ${y + height} H${x + 10} Q${x} ${y + height} ${x} ${y + height - 10} Z M${x + 12} ${y} V${y + height}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
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

function qualityLabel(quality: AssertionQuality): string {
  if (quality === 'strict') return 'strong'
  if (quality === 'unknown') return 'not graded'
  return quality
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
    return await codeToHtml(formatted, { lang: 'typescript', theme: 'one-light' })
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

const ASSERTION_HTML_CSS = `
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --surface: #ffffff;
  --surface-muted: #f8fafc;
  --border: #d9e0ea;
  --border-strong: #b9c4d4;
  --text: #111827;
  --muted: #64748b;
  --accent: #0f766e;
  --danger: #b42318;
  --ok: #16794c;
  --warn: #a16207;
  --code-border: #d7dde7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main {
  min-width: 0;
  padding: 28px 0 48px;
}
.page-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1180px);
  gap: 22px;
  width: min(1450px, calc(100vw - 28px));
  margin: 0 auto;
}
h1, h2, h3, p { margin-top: 0; }
.page-header, .test-case, .implementations {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
}
.page-header { padding: 24px; margin-bottom: 18px; }
.implementations { padding: 18px; margin-top: 14px; }
.toc {
  position: sticky;
  top: 14px;
  align-self: start;
  max-height: calc(100vh - 28px);
  overflow: auto;
  padding: 14px;
  margin-top: 28px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
}
.toc h2 { margin-bottom: 10px; font-size: 11px; color: var(--text); font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 3px 0; }
.toc a {
  display: block;
  color: var(--muted);
  text-decoration: none;
  overflow-wrap: anywhere;
  border-radius: 6px;
  padding: 6px 8px;
  border-left: 3px solid transparent;
  font-weight: 600;
}
.toc a:hover { color: var(--text); background: var(--surface-muted); }
.toc a[aria-current="true"] {
  color: var(--accent);
  background: #ecfdf5;
  border-left-color: var(--accent);
  font-weight: 700;
}
.toc-level-1 a { color: var(--text); font-size: 15px; font-weight: 850; line-height: 1.35; }
.toc-level-2 { padding-left: 6px; margin-top: 10px !important; }
.toc-level-2 a { color: var(--text); font-size: 14px; font-weight: 850; line-height: 1.3; }
.toc-level-3 { padding-left: 14px; font-size: 11px; }
.toc-level-3 a { padding: 4px 8px; font-size: 11px; font-weight: 650; line-height: 1.35; }
.eyebrow {
  margin-bottom: 4px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 { font-size: 28px; line-height: 1.15; margin-bottom: 16px; }
.report-summary {
  max-width: 820px;
  margin-bottom: 16px;
  color: var(--muted);
  font-size: 14px;
}
.summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.summary-strip div {
  padding: 10px 12px;
  background: linear-gradient(180deg, #ffffff, #f8fafc);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.summary-value { display: block; font-size: 18px; line-height: 1.15; font-weight: 800; color: var(--text); }
.summary-label { display: block; margin-top: 2px; font-size: 10px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.section-title { font-size: 18px; margin: 20px 0 10px; }
.test-case { padding: 18px; margin-bottom: 14px; }
.test-case > h2 { font-size: 17px; margin-bottom: 10px; }
.case-explainer, .case-impact, .confidence-note { margin-bottom: 10px; }
.case-impact, .confidence-note { color: var(--muted); }
.subsection { margin-top: 14px; }
.subsection h3 { font-size: 12px; margin-bottom: 7px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.run-meta, .case-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin: 0;
}
.run-meta div, .case-meta div {
  min-width: 0;
  padding: 8px 10px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
}
dt { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.scope { margin: 18px 0 0; color: var(--muted); }
.muted { color: var(--muted); }
.status, .quality {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 700;
  border: 1px solid currentColor;
}
.status-passed, .quality-strict { color: var(--ok); background: #e8f7ef; }
.status-failed, .quality-unknown { color: var(--danger); background: #fff0ee; }
.status-aborted, .quality-shallow { color: var(--warn); background: #fff8e6; }
.quality-moderate { color: #1d4ed8; background: #eff6ff; }
.flow-frame { margin: 0; }
.flow-frame svg {
  display: block;
  width: 100%;
  height: auto;
  max-height: 340px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.video-frame { margin: 0 0 14px; }
video {
  display: block;
  width: 100%;
  max-height: 520px;
  background: #020617;
  border: 1px solid var(--border);
  border-radius: 8px;
}
figcaption { margin-top: 6px; font-size: 12px; }
a { color: var(--accent); }
.assertions { padding-left: 20px; }
.assertions li { margin: 8px 0; }
.assertions code, dd code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
}
.helper-ref { margin-top: 4px; color: var(--muted); }
details > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}
details > summary::-webkit-details-marker { display: none; }
.test-code-details,
.checks-details {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.test-code-details > summary,
.checks-details > summary,
.implementations details > summary {
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.test-code-details > summary::before,
.checks-details > summary::before,
.implementations details > summary::before,
.check-code > summary::before {
  content: ">";
  display: inline-block;
  margin-right: 6px;
  color: var(--muted);
}
.test-code-details[open] > summary::before,
.checks-details[open] > summary::before,
.implementations details[open] > summary::before,
.check-code[open] > summary::before {
  transform: rotate(90deg);
}
.implementations details > summary .section-title { display: inline; margin: 0; }
.check-code {
  display: block;
  margin-top: 4px;
}
.check-code > summary {
  display: inline-block;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: none;
  letter-spacing: 0;
}
.check-code code { display: inline-block; margin-top: 4px; }
.shiki, .fallback-code {
  border: 1px solid var(--code-border);
  border-radius: 7px;
  overflow: auto;
  padding: 10px !important;
  margin: 0 !important;
  font-size: 12px;
  line-height: 1.55;
}
.shiki code, .fallback-code code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.code-line {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  min-width: max-content;
}
.line-number {
  padding-right: 10px;
  color: #94a3b8;
  text-align: right;
  user-select: none;
}
.line-source { white-space: pre; }
.code-line.is-highlighted {
  background: #fef3c7;
  box-shadow: inset 3px 0 0 #d97706;
}
@media (max-width: 900px) {
  .page-shell { display: block; width: min(100vw - 20px, 1120px); }
  main { padding-top: 18px; }
  .toc { position: static; max-height: none; margin: 18px 0 0; }
  .summary-strip { grid-template-columns: 1fr; }
  .page-header, .test-case { padding: 16px; }
  h1 { font-size: 24px; }
}
`

const ASSERTION_HTML_SCRIPT = `
(() => {
  const links = [...document.querySelectorAll('.toc a[data-section-id]')]
  const sections = links
    .map((link) => document.getElementById(link.dataset.sectionId))
    .filter(Boolean)
  if (!links.length || !sections.length || !('IntersectionObserver' in window)) return
  const setActive = (id) => {
    for (const link of links) {
      const active = link.dataset.sectionId === id
      if (active) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
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
  }, { rootMargin: '-20% 0px -65% 0px', threshold: 0 })
  for (const section of sections) observer.observe(section)
  if (location.hash) setActive(location.hash.slice(1))
})()
;(() => {
  const clear = (testCase) => {
    testCase.querySelectorAll('.flow-node.is-active, .code-line.is-highlighted').forEach((el) => {
      el.classList.remove(el.classList.contains('flow-node') ? 'is-active' : 'is-highlighted')
    })
  }
  const activate = (node) => {
    const testCase = node.closest('.test-case')
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
      const testCase = node.closest('.test-case')
      if (testCase) clear(testCase)
    })
  })
})()
`

function playbackTests(events: PlaywrightPlaybackEvent[]): Array<{
  name: string
  title: string
  location: string
  status: string
  durationMs?: number
}> {
  // One entry per (name, location). Retries and heal-cycle reruns share both
  // and fold into the latest test-end. Two distinct tests that share a title
  // (and therefore a name, since name = `test-case-${slugify(title)}`) but
  // live at different locations stay separate — the HTML export disambiguates
  // them via positional anchor IDs. Map preserves first-seen insertion order.
  const latest = new Map<string, { name: string; title: string; location: string; status: string; durationMs?: number }>()
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const key = `${event.test.name}@${event.test.location}`
    latest.set(key, {
      name: event.test.name,
      title: event.test.title,
      location: event.test.location,
      status: event.status,
      durationMs: event.durationMs,
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
  const fn = node.arguments[1]
  if (!fn) return undefined
  return ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn.body : undefined
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
  statusClass,
  wrapSvgText,
}
