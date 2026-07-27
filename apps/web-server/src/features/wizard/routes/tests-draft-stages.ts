import fs from 'fs'
import path from 'path'
import { paths as draftPaths, readDraft, type DraftRecord, type DraftRepo } from '../logic/draft-store'
import {
  extractGeneratedSpecOutput,
  extractIntentSummary,
  extractPlan,
} from '../logic/wizard-output-parser'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
  resolveWizardSessionId,
} from '../logic/wizard-agent-spawner'
import { refForAgentSpawn } from '../../agent-sessions/logic/agent-session-tailer'
import { randomUUID } from 'crypto'
import type { TestsDraftRouteDeps } from './tests-draft'
import { defaultFeatureName, isCancelled, isStageCurrent, patchDraft, transitionDraft } from './tests-draft-support'

// Wizard pipeline ports. The agent spawners are injected — production wires
// them to real `claude -p` pty invocations; tests pass synchronous stubs.
//
// Each spawner returns a promise resolving to the agent's full stdout once
// the agent exits. The route layer extracts the structured output from that
// stream via wizard-output-parser.

export interface PlanAgentInput {
  draftId: string
  agent: 'claude' | 'codex'
  prdText: string
  planMode?: PlanMode
  planTemplatePath?: string
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
  // Session id to pass via `--session-id` (claude only). Lets the live
  // structured-event WS tail the agent's JSONL from t=0. Undefined for codex.
  pinSessionId?: string
}

export type PlanMode = 'context' | 'diff-only'

export interface SpecAgentInput {
  draftId: string
  agent: 'claude' | 'codex'
  featureName: string
  plan: unknown
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
  resumeSessionId?: string
  pinSessionId?: string
}

// ---- pipeline drivers (tested via accept-plan / spec-ready transitions) ----

export async function runPlanStage(deps: TestsDraftRouteDeps, draftId: string): Promise<void> {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  if (rec.status !== 'planning') return
  const picked = pickWizardAgent(deps)
  if (!picked.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: picked.error })
    return
  }
  const p = draftPaths(deps.logsDir, draftId)
  // Pin the claude session id (codex has no equivalent) so the live agent-
  // session WS can tail the JSONL log from the moment of spawn.
  const pinSessionId = picked.agent === 'claude' ? randomUUID() : undefined
  const planAgentSessionRef = refForAgentSpawn({ agent: picked.agent, cwd: p.draftDir, sessionId: pinSessionId })
  const planSpawnedAt = new Date().toISOString()
  patchDraft(deps, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'planning',
    planAgentSessionRef,
    planAgentSpawnedAt: planSpawnedAt,
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'planning')) return
  const planTemplate = selectPlanTemplate(rec)
  let stream: string
  try {
    stream = await deps.spawnPlanAgent({
      draftId,
      agent: picked.agent,
      prdText: rec.prdText,
      planMode: planTemplate.mode,
      planTemplatePath: planTemplate.templatePath,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.planAgentLog,
      pinSessionId,
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transitionDraft(deps, draftId, 'error', {
      errorMessage: `plan agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractPlan(stream)
  if (!parsed.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.writeFileSync(p.planJson, JSON.stringify(parsed.value, null, 2), 'utf8')
  const intent = extractIntentSummary(stream)
  const intentSummary = intent.ok ? intent.value : 'No intent summary produced by agent.'
  fs.writeFileSync(p.intentMd, intentSummary, 'utf8')
  // Resolve the agent's persisted session id for the spec stage to `--resume`:
  // claude's is the id we pinned; codex's is located from its session log by
  // cwd + spawn time (no formatter marker to parse anymore).
  const sessionRef = resolveWizardSessionId({
    agent: picked.agent,
    cwd: p.draftDir,
    pinSessionId,
    spawnedAt: planSpawnedAt,
  })
  transitionDraft(deps, draftId, 'plan-ready', {
    plan: parsed.value,
    intentSummary,
    activeAgentStage: undefined,
    ...(sessionRef
      ? { planAgentSessionId: sessionRef.id, planAgentSessionKind: sessionRef.kind }
      : {}),
  })
}

export function hasUserContext(rec: Pick<DraftRecord, 'prdText' | 'additionalNotes' | 'prdDocuments'>): boolean {
  return rec.prdText.trim().length > 0
    || (rec.additionalNotes?.trim().length ?? 0) > 0
    || rec.prdDocuments.length > 0
}

export function selectPlanTemplate(rec: Pick<DraftRecord, 'prdText' | 'additionalNotes' | 'prdDocuments'>): {
  mode: PlanMode
  templatePath: string
} {
  return hasUserContext(rec)
    ? { mode: 'context', templatePath: STAGE1_TEMPLATE }
    : { mode: 'diff-only', templatePath: STAGE1_DIFF_TEMPLATE }
}

export async function runSpecStage(deps: TestsDraftRouteDeps, draftId: string): Promise<void> {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  if (rec.status !== 'generating') return
  const picked = pickWizardAgent(deps)
  if (!picked.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: picked.error })
    return
  }
  const p = draftPaths(deps.logsDir, draftId)
  const resumeSessionId = rec.planAgentSessionKind === picked.agent
    ? rec.planAgentSessionId
    : undefined
  // Pin the spec agent's claude session id too. If we're resuming, the
  // session id is fixed by the prior agent — reuse it so the JSONL keeps
  // appending to the same file (claude's `--resume` writes to the same path).
  const pinSessionId = picked.agent === 'claude'
    ? (resumeSessionId ?? randomUUID())
    : undefined
  const specAgentSessionRef = refForAgentSpawn({ agent: picked.agent, cwd: p.draftDir, sessionId: pinSessionId })
  patchDraft(deps, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'generating',
    specAgentSessionRef,
    specAgentSpawnedAt: new Date().toISOString(),
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'generating')) return
  let stream: string
  try {
    stream = await deps.spawnSpecAgent({
      draftId,
      agent: picked.agent,
      featureName: rec.featureName ?? defaultFeatureName(rec),
      plan: rec.plan,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.specAgentLog,
      resumeSessionId,
      pinSessionId: resumeSessionId ? undefined : pinSessionId,
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transitionDraft(deps, draftId, 'error', {
      errorMessage: `spec agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractGeneratedSpecOutput(stream)
  if (!parsed.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.mkdirSync(p.generatedDir, { recursive: true })
  for (const file of parsed.value.files) {
    const target = path.join(p.generatedDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  transitionDraft(deps, draftId, 'spec-ready', {
    generatedFiles: parsed.value.files.map((f) => f.path),
    devDependencies: parsed.value.devDependencies,
    activeAgentStage: undefined,
  })
}

// ---- helpers ----

export function tailIfExists(file: string, bytes = 4096): string {
  if (!fs.existsSync(file)) return ''
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - bytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export function pickWizardAgent(deps: TestsDraftRouteDeps): { ok: true; agent: 'claude' | 'codex' } | { ok: false; error: string } {
  return deps.pickAgent?.() ?? { ok: true, agent: 'claude' }
}
