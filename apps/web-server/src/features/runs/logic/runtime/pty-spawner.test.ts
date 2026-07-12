import { describe, expect, it } from 'vitest'
import { realPtyFactory, type PtyFactory, type PtySpawnOptions } from './pty-spawner'

// Integration tests against the real node-pty native binding. Skipped
// cleanly (never a hard failure) on environments that lack the built
// binding — mirrors the itIfFixture pattern in trace-enrichment.test.ts.
const canLoadPty = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node-pty')
    return true
  } catch {
    return false
  }
})()
const itIfPty = canLoadPty ? it : it.skip

describe('realPtyFactory', () => {
  itIfPty('returns a cached factory instance exposing a full PtyHandle surface', async () => {
    const factory1 = realPtyFactory()
    const factory2 = realPtyFactory()
    // Module-level caching: second call must reuse the first factory.
    expect(factory1).toBe(factory2)

    const handle = factory1({ command: 'cat', cwd: process.cwd() })
    try {
      expect(typeof handle.pid).toBe('number')
      expect(handle.pid).toBeGreaterThan(0)

      const chunks: string[] = []
      const dataDisposable = handle.onData((chunk) => chunks.push(chunk))
      expect(typeof dataDisposable.dispose).toBe('function')

      const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
        const exitDisposable = handle.onExit((e) => {
          exitDisposable.dispose()
          resolve(e)
        })
      })

      handle.write('hello-pty\n')
      await waitFor(() => chunks.join('').includes('hello-pty'))

      expect(() => handle.resize(100, 40)).not.toThrow()

      handle.kill()
      const exit = await exited
      expect(exit).toHaveProperty('exitCode')

      dataDisposable.dispose()
    } finally {
      try { handle.kill() } catch { /* already dead */ }
    }
  }, 15_000)

  itIfPty('applies explicit cols/rows and env overrides', async () => {
    const factory = realPtyFactory()
    const output = await runCommand(factory, {
      command: 'stty size; echo "VAR_IS=$MY_TEST_VAR"',
      cwd: process.cwd(),
      cols: 200,
      rows: 50,
      env: { MY_TEST_VAR: 'canary-pty-test' },
    })
    // `stty size` prints "<rows> <cols>".
    expect(output).toContain('50 200')
    expect(output).toContain('VAR_IS=canary-pty-test')
  }, 15_000)

  itIfPty('defaults cols/rows to 120x30 when omitted', async () => {
    const factory = realPtyFactory()
    const output = await runCommand(factory, { command: 'stty size', cwd: process.cwd() })
    expect(output).toContain('30 120')
  }, 15_000)

  itIfPty('resolves shell in priority order: opts.shell > $SHELL > /bin/bash default', async () => {
    const factory = realPtyFactory()

    // opts.shell wins even when $SHELL is set to something else.
    const withOptsShell = await runCommand(factory, {
      command: 'echo $0',
      cwd: process.cwd(),
      shell: '/bin/bash',
      env: { SHELL: '/bin/zsh' },
    })
    expect(withOptsShell).toContain('bash')

    const originalShell = process.env.SHELL
    try {
      // Falls back to process.env.SHELL when opts.shell is omitted.
      process.env.SHELL = '/bin/bash'
      const withEnvShell = await runCommand(factory, { command: 'echo $0', cwd: process.cwd() })
      expect(withEnvShell).toContain('bash')

      // Falls back to /bin/bash when neither opts.shell nor $SHELL is set.
      delete process.env.SHELL
      const withDefaultShell = await runCommand(factory, { command: 'echo $0', cwd: process.cwd() })
      expect(withDefaultShell).toContain('bash')
    } finally {
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
    }
  }, 20_000)
})

// ─── Test helpers ───────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// Spawns a one-shot command via the real factory and resolves with all
// stdout collected before the shell exits.
async function runCommand(factory: PtyFactory, opts: PtySpawnOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const handle = factory(opts)
    let output = ''
    const timeout = setTimeout(() => {
      try { handle.kill() } catch { /* already dead */ }
      reject(new Error(`runCommand timed out; output so far: ${output}`))
    }, 10_000)
    handle.onData((chunk) => { output += chunk })
    handle.onExit(() => {
      clearTimeout(timeout)
      resolve(output)
    })
  })
}
