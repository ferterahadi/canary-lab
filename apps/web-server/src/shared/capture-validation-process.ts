import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process'

type Output = { stdout: string; stderr: string; combined: string }
type ProcessOutcome =
  | { kind: 'exit'; code: number | null }
  | { kind: 'spawn-error'; error: Error }
  | { kind: 'timeout' }

export type ValidationProcessResult = Output & ProcessOutcome

export interface ValidationProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
}

/** Capture validation output without deciding whether a missing tool is a failure. */
export function captureValidationProcess(options: ValidationProcessOptions): Promise<ValidationProcessResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let combined = ''
    let settled = false
    const child = (options.spawn ?? spawn)(options.command, options.args, {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...outcome, stdout, stderr, combined })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* timeout still settles if killing fails */ }
      settle({ kind: 'timeout' })
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      combined += text
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      combined += text
    })
    child.on('error', (error) => settle({ kind: 'spawn-error', error }))
    child.on('close', (code) => settle({ kind: 'exit', code }))
  })
}
