import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentProcessHandle } from './agent-process'
import { recoverAgentAnswer, type ProducerAgentKind } from './agent-producer'

interface AgentCompletionOptions {
  agent: ProducerAgentKind
  signal?: AbortSignal
  idleMs: number
  outputDirectoryPrefix: string
  errorLabel: string
  cancellationMessage: string
  start(context: { outputPath: string | undefined; onIdle: () => void }): AgentProcessHandle
}

type Completion = { ok: true; output: string } | { ok: false; error: unknown }

/** Own the answer-file lifetime independently of process closure: cancellation
 *  must release the caller immediately, while the process may still be draining. */
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
        finish({ ok: false, error: new Error(options.cancellationMessage) })
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
