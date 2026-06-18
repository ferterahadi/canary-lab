import fs from 'fs'
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import type {
  PlanAgentInput,
  SpecAgentInput,
} from '../routes/tests-draft'
import {
  WizardAgentCancelledError,
  killChild,
  type WizardAgentRegistry,
} from './wizard-agent-registry'
import {
  buildWizardArgs,
  buildPlanPrompt,
  buildSpecPrompt,
  createTeeSink,
  loadTemplate,
  type WizardAgentKind,
} from './wizard-agent-spawner'
import { WIZARD_PLAN_MODELS, WIZARD_SPEC_MODELS, modelFor } from './agent-models'
import { startIdleTimer, type IdleTimer } from './agent-idle-timer'
import { claudeSessionLogPath } from './agent-session-log'
import { recoverClaudeFinalText } from './agent-stream'

// Headless driver for the wizard agents (the Portify model). Spawns the agent
// CLI directly, tees stdout/stderr to the agent log, and returns the final
// stream for the route to parse. The live view is the agent's session JSONL,
// tailed by AgentSessionView — there is no pty/pane/formatter anymore. Excluded
// from coverage in vitest.config.ts; the pure helpers in `wizard-agent-spawner.ts`
// carry the wizard's parseable-output correctness.

// Kill a wedged agent after this long with NO activity (no session-JSONL / log
// growth). No hard wall-clock — a slow-but-working agent isn't punished.
const WIZARD_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export interface SpawnAgentDeps {
  // Override the `claude` / `codex` binary (tests / restricted PATH).
  claudeBin?: string
  codexBin?: string
  registry?: WizardAgentRegistry | null
  // CWD for the agent — usually the draft directory so any side files the
  // agent emits land there.
  cwd?: string
  // Override prompt template paths (tests).
  planTemplate?: string
  specTemplate?: string
  // Override the spawn impl (tests).
  spawnImpl?: typeof nodeSpawn
}

function runAgent(opts: {
  draftId: string
  agent: WizardAgentKind
  bin: string
  args: string[]
  cwd: string
  agentLogPath: string
  registry?: WizardAgentRegistry | null
  label: string
  // The claude session id (pinned or resumed) — used to watch its JSONL for
  // idle activity. undefined for codex (its piped stdout grows the log instead).
  claudeSessionId?: string
  spawnImpl: typeof nodeSpawn
}): Promise<string> {
  const sink = createTeeSink({ logPath: opts.agentLogPath })
  sink.push(`[wizard] ${opts.label}\n`)
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ChildProcess
    try {
      child = opts.spawnImpl(opts.bin, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new Error(`wizard agent spawn failed: ${(e as Error).message}`))
      return
    }
    const lease = opts.registry?.register({ draftId: opts.draftId, child, logPath: opts.agentLogPath })

    // Activity signal: claude `-p` is silent on stdout, so watch its session-JSONL
    // growth; codex's stdout is teed to the log, so watch that.
    const activityPath = opts.agent === 'claude' && opts.claudeSessionId
      ? claudeSessionLogPath(opts.cwd, opts.claudeSessionId)
      : opts.agentLogPath
    let idleTimer: IdleTimer | undefined
    const finish = (err: Error | null, stream?: string): void => {
      if (settled) return
      settled = true
      idleTimer?.stop()
      lease?.clear()
      if (err) reject(err)
      else resolve(stream ?? '')
    }
    idleTimer = startIdleTimer({
      idleMs: WIZARD_IDLE_TIMEOUT_MS,
      activity: () => { try { return fs.statSync(activityPath).size } catch { return 0 } },
      onIdle: () => { killChild(child) },
    })

    // Any output resets the idle clock (the primary liveness signal). claude's
    // is stream-json deltas; codex's is its own readable progress.
    child.stdout?.on('data', (chunk: Buffer) => { idleTimer?.bump(); sink.push(chunk.toString('utf-8')) })
    child.stderr?.on('data', (chunk: Buffer) => { idleTimer?.bump(); sink.push(chunk.toString('utf-8')) })
    child.on('error', (err) => finish(new Error(`wizard agent spawn failed: ${err.message}`)))
    child.on('close', (code) => {
      const cancelled = lease?.isCancelled() ?? false
      if (cancelled) {
        finish(new WizardAgentCancelledError(opts.draftId))
        return
      }
      if (code === 0) {
        // claude stdout is stream-json envelopes → recover the final message;
        // codex stdout is already the plain answer text.
        const stream = sink.fullStream()
        finish(null, opts.agent === 'claude' ? recoverClaudeFinalText(stream) : stream)
      } else {
        finish(new Error(`wizard agent exited with code ${code}. Tail of agent log:\n${sink.fullStream().slice(-2000)}`))
      }
    })
  })
}

export function spawnPlanAgent(
  deps: SpawnAgentDeps,
): (input: PlanAgentInput) => Promise<string> {
  return async (input) => {
    const templatePath = input.planTemplatePath ?? deps.planTemplate
    const prompt = buildPlanPrompt({
      prdText: input.prdText,
      repos: input.repos,
      template: templatePath ? loadTemplate(templatePath) : undefined,
    })
    const args = buildWizardArgs(input.agent, prompt, {
      pinSessionId: input.pinSessionId,
      model: modelFor(WIZARD_PLAN_MODELS, input.agent),
    })
    return runAgent({
      draftId: input.draftId,
      agent: input.agent,
      bin: binFor(input.agent, deps),
      args,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      registry: deps.registry ?? null,
      label: `${input.agent} plan agent started`,
      claudeSessionId: input.agent === 'claude' ? input.pinSessionId : undefined,
      spawnImpl: deps.spawnImpl ?? nodeSpawn,
    })
  }
}

export function spawnSpecAgent(
  deps: SpawnAgentDeps,
): (input: SpecAgentInput) => Promise<string> {
  return async (input) => {
    const prompt = buildSpecPrompt({
      featureName: input.featureName,
      plan: input.plan,
      repos: input.repos,
      template: deps.specTemplate ? loadTemplate(deps.specTemplate) : undefined,
    })
    const args = buildWizardArgs(input.agent, prompt, {
      resumeSessionId: input.resumeSessionId,
      pinSessionId: input.pinSessionId,
      model: modelFor(WIZARD_SPEC_MODELS, input.agent),
    })
    return runAgent({
      draftId: input.draftId,
      agent: input.agent,
      bin: binFor(input.agent, deps),
      args,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      registry: deps.registry ?? null,
      label: `${input.agent} spec agent started`,
      claudeSessionId: input.agent === 'claude' ? (input.resumeSessionId ?? input.pinSessionId) : undefined,
      spawnImpl: deps.spawnImpl ?? nodeSpawn,
    })
  }
}

function binFor(agent: WizardAgentKind, deps: SpawnAgentDeps): string {
  return agent === 'claude' ? (deps.claudeBin ?? 'claude') : (deps.codexBin ?? 'codex')
}
