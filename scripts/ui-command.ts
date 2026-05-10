// Thin CLI glue around `createServer`. Coverage is excluded — boots Fastify
// against the real project root and binds a port, neither of which is
// deterministically testable without a real listen() call.

import path from 'path'
import readline from 'readline'
import { createServer } from '../apps/web-server/server'
import { getProjectRoot } from '../shared/runtime/project-root'
import { openBrowser } from '../apps/web-server/lib/open-browser'

export interface UiCommandOptions {
  port?: number
  projectRoot?: string
  // Injected for tests / future programmatic use.
  log?: (msg: string) => void
  exit?: (code: number) => void
  confirmShutdown?: () => Promise<boolean>
}

export async function runUi(argv: string[], opts: UiCommandOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  let exitRequested = false
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const requestExit = (code: number): void => {
    exitRequested = true
    exit(code)
  }
  const portFromArgs = parsePort(argv, { log, exit: requestExit })
  if (exitRequested) return
  const port = portFromArgs ?? opts.port ?? 7421
  const noOpen = argv.includes('--no-open')
  const projectRoot = opts.projectRoot ?? getProjectRoot()
  const { app, runStore, revertAllEnvsets, cancelAllWizardAgents } = await createServer({ projectRoot })

  // Stop active runs and revert any in-flight envset swaps if the user kills
  // the UI server before their runs finish. `orch.stop()` owns the process
  // cleanup path for service PTYs, Playwright, and heal agents.
  let cleanedUp = false
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return
    cleanedUp = true
    cancelAllWizardAgents()
    await runStore.abortAllActiveOrStale()
    revertAllEnvsets()
  }
  const shutdown = async (code: number): Promise<void> => {
    await cleanup()
    try { await app.close() } catch { /* already closed or never fully opened */ }
    exit(code)
  }
  const confirmShutdown = opts.confirmShutdown ?? confirmShutdownFromStdin
  let sigintConfirmationOpen = false
  process.on('SIGINT', () => {
    if (sigintConfirmationOpen || cleanedUp) return
    sigintConfirmationOpen = true
    void (async () => {
      const confirmed = await confirmShutdown()
      sigintConfirmationOpen = false
      if (confirmed) {
        await shutdown(130)
      } else {
        log('Shutdown cancelled. Canary Lab is still running.')
      }
    })()
  })
  process.once('SIGTERM', () => { void shutdown(143) })
  process.once('beforeExit', () => { void cleanup() })

  await app.listen({ port, host: '127.0.0.1' })
  const url = `http://localhost:${port}`
  log(`Open ${url}`)
  log(`Project root: ${path.relative(process.cwd(), projectRoot) || '.'}`)
  if (!noOpen) {
    openBrowser(url)
  }
}

async function confirmShutdownFromStdin(): Promise<boolean> {
  const input = process.stdin
  const output = process.stdout
  const prompt = '\nStop Canary Lab and kill active runs? Press Y to confirm, or any other key to cancel. '

  if (!input.isTTY || !output.isTTY) {
    return await new Promise((resolve) => {
      const rl = readline.createInterface({ input, output })
      rl.question('\nStop Canary Lab and kill active runs? [y/N] ', (answer) => {
        rl.close()
        resolve(/^y(es)?$/i.test(answer.trim()))
      })
    })
  }

  output.write(prompt)
  readline.emitKeypressEvents(input)
  const wasRaw = input.isRaw
  input.setRawMode(true)
  input.resume()

  return await new Promise((resolve) => {
    const finish = (confirmed: boolean): void => {
      input.off('keypress', onKeypress)
      input.setRawMode(wasRaw)
      output.write('\n')
      resolve(confirmed)
    }
    const onKeypress = (str: string): void => {
      finish(str.toLowerCase() === 'y')
    }
    input.on('keypress', onKeypress)
  })
}

export function parsePort(
  argv: string[],
  opts: Pick<UiCommandOptions, 'log' | 'exit'> = {},
): number | undefined {
  const log = opts.log ?? ((m: string) => console.log(m))
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') {
      if (!argv[i + 1]) {
        log('Usage: canary-lab ui [--port <n>] [--no-open]')
        exit(1)
        return undefined
      }
      return parsePortValue(argv[i + 1], { log, exit })
    } else if (a.startsWith('--port=')) {
      return parsePortValue(a.slice('--port='.length), { log, exit })
    }
  }
  return undefined
}

function parsePortValue(
  raw: string,
  opts: Required<Pick<UiCommandOptions, 'log' | 'exit'>>,
): number | undefined {
  if (!/^\d+$/.test(raw)) {
    opts.log(`Invalid port "${raw}". Use a number between 1 and 65535.`)
    opts.exit(1)
    return undefined
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    opts.log(`Invalid port "${raw}". Use a number between 1 and 65535.`)
    opts.exit(1)
    return undefined
  }
  return n
}
