import type {
  PlanAgentInput,
  SpecAgentInput,
} from '../routes/tests-draft'
import type { PaneBroker } from './pane-broker'
import type { PtyFactory } from '../../../shared/e2e-runner/pty-spawner'
import {
  buildClaudeCommand,
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
  // CWD for the pty — usually the draft directory so any side files the
  // agent emits land there.
  cwd?: string
  // Override prompt template paths (tests).
  planTemplate?: string
  specTemplate?: string
}

function runAgent(opts: {
  command: string
  cwd: string
  agentLogPath: string
  ptyFactory: PtyFactory
  broker?: PaneBroker | null
  paneId: string
}): Promise<string> {
  const sink = createTeeSink({
    logPath: opts.agentLogPath,
    broker: opts.broker,
    paneId: opts.paneId,
  })
  return new Promise<string>((resolve, reject) => {
    let pty
    try {
      pty = opts.ptyFactory({ command: opts.command, cwd: opts.cwd })
    } catch (e) {
      reject(new Error(`pty spawn failed: ${(e as Error).message}`))
      return
    }
    pty.onData((chunk) => sink.push(chunk))
    pty.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        resolve(sink.fullStream())
      } else {
        reject(
          new Error(
            `claude -p exited with code ${exitCode}. Tail of agent log:\n${sink.fullStream().slice(-2000)}`,
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
    const prompt = buildPlanPrompt({
      prdText: input.prdText,
      repos: input.repos,
      template: deps.planTemplate ? loadTemplate(deps.planTemplate) : undefined,
    })
    const command = buildClaudeCommand(prompt, deps.claudeBin)
    return runAgent({
      command,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      ptyFactory: deps.ptyFactory,
      broker: deps.broker ?? null,
      paneId: paneIdForDraft(input.draftId),
    })
  }
}

export function spawnSpecAgent(
  deps: SpawnAgentDeps,
): (input: SpecAgentInput) => Promise<string> {
  return async (input) => {
    const prompt = buildSpecPrompt({
      plan: input.plan,
      skills: input.skills,
      repos: input.repos,
      template: deps.specTemplate ? loadTemplate(deps.specTemplate) : undefined,
    })
    const command = buildClaudeCommand(prompt, deps.claudeBin)
    return runAgent({
      command,
      cwd: deps.cwd ?? input.draftDir,
      agentLogPath: input.agentLogPath,
      ptyFactory: deps.ptyFactory,
      broker: deps.broker ?? null,
      paneId: paneIdForDraft(input.draftId),
    })
  }
}
