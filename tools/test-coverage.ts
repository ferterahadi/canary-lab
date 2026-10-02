import path from 'node:path'
import { command, sourceRoot } from './benchmark-study/files'

export function coverageTimeout(value: string | undefined): number {
  const timeout = value === undefined ? 180_000 : Number(value)
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('CANARY_COVERAGE_TIMEOUT_MS must be a positive integer')
  return timeout
}

async function main(): Promise<void> {
  const timeoutMs = coverageTimeout(process.env.CANARY_COVERAGE_TIMEOUT_MS)
  const result = await command(process.execPath, [path.join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', ...process.argv.slice(2)], {
    cwd: sourceRoot, timeoutMs, killGroupOnClose: true,
    onOutput: (value, stream) => process[stream].write(value),
  })
  if (result.timedOut) process.stderr.write(`Coverage exceeded ${timeoutMs}ms; terminated the test process group.\n`)
  process.exitCode = result.timedOut ? 124 : result.code ?? 1
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
