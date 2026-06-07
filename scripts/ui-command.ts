// Thin CLI glue around `createServer`. Coverage is excluded — boots Fastify
// against the real project root and binds a port, neither of which is
// deterministically testable without a real listen() call.

import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import { createServer } from '../apps/web-server/server'
import { getProjectRoot } from '../shared/runtime/project-root'
import { openBrowser } from '../apps/web-server/lib/open-browser'
import { loadProjectConfig, resolveProjectPort } from '../apps/web-server/lib/runtime/launcher/project-config'
import { upsertWorkspace } from '../shared/runtime/workspace-registry'
import { refreshAgentIntegrationsQuietly } from './agent'
import { installServerLogging, type ServerLogHandle } from '../apps/web-server/lib/runtime/server-log'

export interface UiCommandOptions {
  projectRoot?: string
  // Injected for tests / future programmatic use.
  log?: (msg: string) => void
  exit?: (code: number) => void
  confirmShutdown?: () => Promise<boolean>
  // Marks this workspace active so the MCP bridge connects to the running UI.
  registerWorkspace?: (projectRoot: string) => void
  // Brings the installed agent skill up to date with this package version.
  // Injected as a no-op / spy in tests so they never touch the real home dir.
  refreshAgents?: () => void
  // Spawns a fresh detached UI for this project (on the new port from config).
  relaunch?: (projectRoot: string) => void
  // Defers the relaunch+shutdown so the HTTP response can flush first.
  schedule?: (fn: () => void) => void
  // Tees the server process's own stdout/stderr to <logsDir>/server/. Injected
  // as a no-op in tests so the real process streams aren't captured.
  setupServerLogging?: (logsDir: string) => ServerLogHandle | void
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
  if (portFromArgs !== undefined) return
  const noOpen = argv.includes('--no-open')
  const projectRoot = opts.projectRoot ?? getProjectRoot()
  const port = resolveProjectPort(loadProjectConfig(projectRoot))
  // Bump this workspace's recency so the single registered MCP bridge resolves
  // *this* project (and its port) as the active target.
  const registerWorkspace = opts.registerWorkspace ?? ((root: string) => { upsertWorkspace(root) })
  registerWorkspace(projectRoot)
  // Keep the installed agent skill (~/.claude, ~/.codex) in lockstep with this
  // package version. An `npm` bump that skips the postinstall `upgrade` hook
  // would otherwise leave a stale skill pinning old behavior; this is the one
  // command users run every session, so it's the reliable enforcement point.
  // Cheap + silent when already current (content-compared, no-ops on match).
  const refreshAgents = opts.refreshAgents
    ?? (() => { refreshAgentIntegrationsQuietly({ log }) })
  refreshAgents()
  // Capture this server process's own output so crashes/misbehaviour can be
  // diagnosed after the fact (the launching terminal's scrollback is the only
  // other copy). Per-run service logs are captured separately by the runner.
  const setupServerLogging = opts.setupServerLogging ?? ((dir: string) => installServerLogging(dir))
  const serverLog = setupServerLogging(path.join(projectRoot, 'logs'))
  // Forward reference: the port-change hook needs `shutdown`, which is defined
  // after the server exists. createServer captures this stable delegate.
  let triggerPortChange: (port: number) => void = () => { /* assigned below */ }
  const { app, runStore, revertAllEnvsets, cancelAllWizardAgents } = await createServer({
    projectRoot,
    onPortChange: (newPort) => triggerPortChange(newPort),
  })

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

  // A Project Settings port change persists the new port server-side, then asks
  // us to relaunch the UI on it and stop this process. The new instance binds a
  // different port, so both can coexist briefly; the browser redirects itself.
  const relaunch = opts.relaunch ?? relaunchUiDetached
  const schedule = opts.schedule ?? ((fn: () => void) => { setTimeout(fn, 150) })
  triggerPortChange = (newPort: number): void => {
    log(`Canary Lab port changed to ${newPort}. Relaunching…`)
    schedule(() => {
      try { relaunch(projectRoot) } finally { void shutdown(0) }
    })
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

  try {
    await app.listen({ port, host: '127.0.0.1' })
  } catch (err) {
    try { await app.close() } catch { /* already closed or never fully opened */ }
    if (isAddressInUseError(err)) {
      log(`Canary Lab port ${port} is already in use. Stop the existing Canary Lab server or free the port, then run \`npx canary-lab ui\` again.`)
      requestExit(1)
      return
    }
    throw err
  }
  const url = `http://localhost:${port}`
  log(`Open ${url}`)
  log(`Project root: ${path.relative(process.cwd(), projectRoot) || '.'}`)
  if (serverLog) log(`Server log: ${path.relative(process.cwd(), serverLog.logPath) || serverLog.logPath}`)
  if (!noOpen) {
    openBrowser(url)
  }
}

// Spawn a fresh, detached `canary-lab ui` for the project. It reads the new
// port from canary-lab.config.json and binds it; this process then exits.
function relaunchUiDetached(projectRoot: string): void {
  const cliPath = process.argv[1] ?? path.join(__dirname, 'cli.js')
  const child = spawn(process.execPath, [cliPath, 'ui', '--no-open'], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, CANARY_LAB_PROJECT_ROOT: projectRoot },
    stdio: 'ignore',
  })
  child.unref()
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
): 'removed-port-option' | undefined {
  const log = opts.log ?? ((m: string) => console.log(m))
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a.startsWith('--port=')) {
      log('`canary-lab ui --port` was removed. Set the port in canary-lab.config.json or the Project Settings dialog.')
      exit(1)
      return 'removed-port-option'
    }
  }
  return undefined
}

function isAddressInUseError(err: unknown): boolean {
  return !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EADDRINUSE'
}
