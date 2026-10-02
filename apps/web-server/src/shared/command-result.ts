import { execFile, type ExecFileOptions } from 'child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export function commandResult(
  command: string,
  args: string[],
  options: ExecFileOptions,
  spawnErrorCode: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.on('error', (err) => resolve({ code: spawnErrorCode, stdout: '', stderr: err.message }))
  })
}
