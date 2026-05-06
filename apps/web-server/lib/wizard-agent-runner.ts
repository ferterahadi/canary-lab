import type {
  PlanAgentInput,
  SpecAgentInput,
} from '../routes/tests-draft'
import type { PaneBroker } from './pane-broker'
import type { PtyFactory } from './runtime/pty-spawner'
import {
  WizardAgentCancelledError,
  type WizardAgentRegistry,
} from './wizard-agent-registry'
import {
  buildWizardCommand,
  buildPlanPrompt,
  buildSpecPrompt,
  createTeeSink,
  loadTemplate,
  paneIdForDraft,
} from './wizard-agent-spawner'

// Pty driver for the wizard agents. Excluded from coverage in
// vitest.config.ts — the pure helpers in `wizard-agent-spawner.ts` are what
// the wizard's correctness rests on. This file is the thin glue that hooks
// node-pty + the tee-sink + the broker together.

export interface SpawnAgentDeps {
  ptyFactory: PtyFactory
  // Optional broker for streaming agent output to WebSocket subscribers.
  broker?: PaneBroker | null
  // Override `claude` binary path (tests / CI).
  claudeBin?: string
  codexBin?: string
  registry?: WizardAgentRegistry | null
  // CWD for the pty — usually the draft directory so any side files the
  // agent emits land there.
  cwd?: string
  // Override prompt template paths (tests).
  planTemplate?: string
  specTemplate?: string
}

function runAgent(opts: {
  draftId: string
  command: string
  cwd: string
  agentLogPath: string
  ptyFactory: PtyFactory
  broker?: PaneBroker | null
  paneId: string
  registry?: WizardAgentRegistry | null
  label: string
  hideRestoreNotice?: boolean
  heartbeatMs?: number
}): Promise<string> {
  opts.broker?.resetPane(opts.paneId)
  const sink = createTeeSink({
    logPath: opts.agentLogPath,
    broker: opts.broker,
    paneId: opts.paneId,
  })
  sink.push(`[wizard] ${opts.label}\n`)
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let seenAgentData = false
    let heartbeat: NodeJS.Timeout | undefined
    const clearHeartbeat = (): void => {
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = undefined
    }
    if (opts.heartbeatMs && opts.heartbeatMs > 0) {
      heartbeat = setTimeout(() => {
        if (!settled && !seenAgentData) {
          sink.push('[wizard] waiting for agent output...\n')
        }
      }, opts.heartbeatMs)
    }
    let pty
    try {
      pty = opts.ptyFactory({ command: opts.command, cwd: opts.cwd })
    } catch (e) {
      settled = true
      clearHeartbeat()
      reject(new Error(`pty spawn failed: ${(e as Error).message}`))
      return
    }
    const lease = opts.registry?.register({
      draftId: opts.draftId,
      pty,
      logPath: opts.agentLogPath,
      broker: opts.broker,
      paneId: opts.paneId,
    })
    pty.onData((chunk) => {
      const next = opts.hideRestoreNotice ? stripRestoreNotice(chunk) : chunk
      if (next) {
        seenAgentData = true
        clearHeartbeat()
        sink.push(next)
      }
    })
    pty.onExit(({ exitCode }) => {
      settled = true
      clearHeartbeat()
      const cancelled = lease?.isCancelled() ?? false
      lease?.clear()
      if (cancelled) {
        reject(new WizardAgentCancelledError(opts.draftId))
        return
      }
      if (exitCode === 0) {
        resolve(sink.fullStream())
      } else {
        reject(
          new Error(
            `wizard agent exited with code ${exitCode}. Tail of agent log:\n${sink.fullStream().slice(-2000)}`,
          ),
        )
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
    const command = buildWizardCommand(input.agent, prompt, {
      claudeBin: deps.claudeBin,
      codexBin: deps.codexBin,
    })
    return runAgent({
      draftId: input.draftId,
      command,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      ptyFactory: deps.ptyFactory,
      broker: deps.broker ?? null,
      paneId: paneIdForDraft(input.draftId, 'planning'),
      registry: deps.registry ?? null,
      label: `${input.agent} plan agent started`,
      hideRestoreNotice: true,
      heartbeatMs: 5000,
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
      skills: input.skills,
      repos: input.repos,
      template: deps.specTemplate ? loadTemplate(deps.specTemplate) : undefined,
    })
    const command = buildWizardCommand(input.agent, prompt, {
      claudeBin: deps.claudeBin,
      codexBin: deps.codexBin,
      resumeSessionId: input.resumeSessionId,
    })
    return runAgent({
      draftId: input.draftId,
      command,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      ptyFactory: deps.ptyFactory,
      broker: deps.broker ?? null,
      paneId: paneIdForDraft(input.draftId, 'generating'),
      registry: deps.registry ?? null,
      label: `${input.agent} spec agent started`,
      hideRestoreNotice: true,
      heartbeatMs: 5000,
    })
  }
}

function stripRestoreNotice(chunk: string): string {
  return chunk.replace(/^Restored session:.*(?:\r?\n)?/gm, '')
}
