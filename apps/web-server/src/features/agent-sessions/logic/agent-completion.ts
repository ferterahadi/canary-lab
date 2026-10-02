import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AGENT_DEFAULT_CHOICE, type StageModelChoice } from '../../../../../../shared/agent-models'
import type { AgentJobRecordRef } from './agent-jobs/types'
import { buildClaudeAgenticArgs, runAgentProcess, type AgentProcessHandle } from './agent-process'
import { agentActivityPath, recoverAgentAnswer, type ProducerAgentKind } from './agent-producer'
import { buildReadOnlyCodexArgs } from './agent-read-only-args'

interface AgentCompletionOptions {
  agent: ProducerAgentKind
  signal?: AbortSignal
  idleMs: number
  outputDirectoryPrefix: string
  errorLabel: string
  cancellationMessage: string
  cancellationMode?: 'immediate' | 'after-close'
  start(context: { outputPath: string | undefined; onIdle: () => void }): AgentProcessHandle
}

type Completion = { ok: true; output: string } | { ok: false; error: unknown }

/** Own the answer-file lifetime. Most callers cancel immediately; coverage waits
 *  for process closure and its persisted job record before returning control. */
export function runAgentCompletion(options: AgentCompletionOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let outputDir: string | undefined
    let handle: AgentProcessHandle
    let idled = false
    let settled = false

    const finish = (result: Completion): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      try {
        if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true })
      } catch (error) {
        // Cleanup must not replace the failure that explains why the agent stopped.
        if (result.ok) result = { ok: false, error }
      }
      if (result.ok) resolve(result.output)
      else reject(result.error)
    }

    function onAbort(): void {
      try {
        handle.stop()
      } finally {
        if (options.cancellationMode !== 'after-close') {
          finish({ ok: false, error: new Error(options.cancellationMessage) })
        }
      }
    }

    try {
      outputDir = options.agent === 'codex'
        ? fs.mkdtempSync(path.join(os.tmpdir(), options.outputDirectoryPrefix))
        : undefined
      const outputPath = outputDir ? path.join(outputDir, 'last-message.txt') : undefined
      handle = options.start({ outputPath, onIdle: () => { idled = true } })
      // Attach both handlers before checking abort, including an already-aborted
      // signal: a later spawn error must still have an observer.
      handle.done.then(
        ({ code, signal, stdout, stderr }) => {
          if (settled) return
          try {
            if (options.cancellationMode === 'after-close' && options.signal?.aborted) {
              throw new Error(options.cancellationMessage)
            }
            if (idled) throw new Error(`${options.errorLabel} idle for ${options.idleMs}ms`)
            if (code !== 0) {
              throw new Error(`${options.errorLabel} failed with ${signal ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`)
            }
            let output = recoverAgentAnswer(options.agent, stdout)
            if (outputPath && fs.existsSync(outputPath)) {
              const fromFile = fs.readFileSync(outputPath, 'utf-8')
              if (fromFile.trim()) output = fromFile
            }
            finish({ ok: true, output })
          } catch (error) {
            finish({ ok: false, error })
          }
        },
        (error: Error) => finish({ ok: false, error: new Error(`${options.errorLabel} failed: ${error.message}`) }),
      )
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
    } catch (error) {
      finish({ ok: false, error })
    }
  })
}

interface ReadOnlyAnswerAgentOptions extends Omit<AgentCompletionOptions, 'start'> {
  prompt: string
  /** JSON schema codex validates its final message against. */
  outputSchemaPath: string
  /** Resolved model+effort for this launch; absent → agent default. */
  models?: StageModelChoice
  cwd?: string
  /** Fired once at spawn. Claude's id is pinned here so its JSONL session log is
   *  locatable for AgentSessionView; codex has no `--session-id` and is found
   *  later by cwd + start time, so its id is empty. */
  onSession?: (session: { agent: ProducerAgentKind; sessionId: string }) => void
  onTick?: (idleMs: number) => void
  spawnScope?: string
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
}

/** One agent pass that reads and answers with JSON, read-only on both arms.
 *  claude streams stream-json for liveness and answer recovery; codex `exec`
 *  reads the prompt from stdin (`-`) and writes its final message to
 *  `--output-last-message`. Every caller here only reads and returns data for
 *  canary to apply, so neither arm is given a write tool. The CLI's raw output
 *  is never forwarded to a caller's progress log: the transcript is the
 *  session log `onSession` pins, and raw stream-json in a log reads as noise. */
export function runReadOnlyAnswerAgent(options: ReadOnlyAnswerAgentOptions): Promise<string> {
  const { agent, prompt, cwd, models = AGENT_DEFAULT_CHOICE } = options
  return runAgentCompletion({
    ...options,
    start: ({ outputPath, onIdle }) => {
      const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
      const args = agent === 'claude'
        ? buildClaudeAgenticArgs(prompt, { model: models.model, effort: models.effort, sessionId: claudeSessionId, readOnly: true })
        : buildReadOnlyCodexArgs({ prompt: '-', models, outputPath, outputSchemaPath: options.outputSchemaPath })
      options.onSession?.({ agent, sessionId: claudeSessionId ?? '' })
      return runAgentProcess({
        command: agent,
        args,
        cwd,
        stdin: agent === 'codex' ? prompt : undefined,
        idleMs: options.idleMs,
        activityPath: agentActivityPath(agent, cwd, claudeSessionId),
        onIdle,
        onTick: options.onTick,
        spawnScope: options.spawnScope,
        ...(options.agentJob
          ? { record: { ...options.agentJob.record, agent, ...(claudeSessionId ? { sessionId: claudeSessionId } : {}) }, agentJobLogsDir: options.agentJob.logsDir }
          : {}),
      })
    },
  })
}
