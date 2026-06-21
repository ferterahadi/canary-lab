// Thin CLI glue around `createServer`. Coverage is excluded — boots Fastify
// against the real project root and binds a port, neither of which is
// deterministically testable without a real listen() call.

import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import { createServer } from '../apps/web-server/server'
import { getProjectRoot, isCanaryLabWorkspace } from '../shared/runtime/project-root'
import { openBrowser } from '../apps/web-server/src/shared/open-browser'
import { loadProjectConfig, resolveProjectPort } from '../apps/web-server/src/features/runs/logic/runtime/launcher/project-config'
import { registerActiveServer, unregisterActiveServer } from '../shared/runtime/active-servers'
import { isActiveRunStatus } from '../shared/run-state'
import { refreshAgentIntegrationsQuietly } from './agent'

export interface UiCommandOptions {
  projectRoot?: string
  // Injected for tests / future programmatic use.
  log?: (msg: string) => void
  exit?: (code: number) => void
  confirmShutdown?: () => Promise<boolean>
  // Number of runs that would actually be killed by a shutdown. When zero, a
  // SIGINT skips the confirm prompt and exits immediately. Injectable for tests.
  countActiveRuns?: () => number
  // Records/clears the live server (projectRoot+port+pid) the MCP bridge follows.
  // Injected as spies in tests so they never touch the real ~/.canary-lab.
  recordActiveServer?: (projectRoot: string, port: number) => void
  clearActiveServer?: () => void
  // Brings the installed agent skill up to date with this package version.
  // Injected as a no-op / spy in tests so they never touch the real home dir.
  refreshAgents?: () => void
  // Spawns a fresh detached UI for this project (on the new port from config).
  relaunch?: (projectRoot: string) => void
  // Defers the relaunch+shutdown so the HTTP response can flush first.
  schedule?: (fn: () => void) => void
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
  // Refuse to boot outside a Canary Lab workspace. `getProjectRoot` walks up
  // and matches any dir with a `features/` folder, so a stray `features/` (e.g.
  // one accidentally scaffolded into the home dir) would otherwise let
  // `canary-lab ui` root a server at `~`. Require the init-only dependency
  // marker instead. The workspace registry is owned solely by `canary-lab init`;
  // `ui` never writes it — it only advertises the running server via the
  // active-server record below.
  if (!isCanaryLabWorkspace(projectRoot)) {
    log(`Canary Lab is not set up in ${projectRoot}. Run \`npx canary-lab init\` here first.`)
    requestExit(1)
    return
  }
  const port = resolveProjectPort(loadProjectConfig(projectRoot))
  const recordActiveServer = opts.recordActiveServer
    ?? ((root: string, p: number) => { registerActiveServer({ projectRoot: root, port: p, pid: process.pid }) })
  const clearActiveServer = opts.clearActiveServer
    ?? (() => { unregisterActiveServer({ pid: process.pid }) })
  // Keep the installed agent skill (~/.claude, ~/.codex) in lockstep with this
  // package version. An `npm` bump that skips the postinstall `upgrade` hook
  // would otherwise leave a stale skill pinning old behavior; this is the one
  // command users run every session, so it's the reliable enforcement point.
  // Cheap + silent when already current (content-compared, no-ops on match).
  const refreshAgents = opts.refreshAgents
    ?? (() => { refreshAgentIntegrationsQuietly({ log }) })
  refreshAgents()
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
    // Stop advertising this server to the MCP bridge before tearing down, so a
    // bridge re-resolving mid-shutdown never targets a port that's going away.
    clearActiveServer()
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
  const countActiveRuns = opts.countActiveRuns
    ?? (() => runStore.list().filter((run) => isActiveRunStatus(run.status)).length)
  let sigintConfirmationOpen = false
  process.on('SIGINT', () => {
    if (sigintConfirmationOpen || cleanedUp) return
    // With nothing in flight, Ctrl+C should just exit — the "kill active runs?"
    // prompt only earns its friction (a blocking, un-echoed keypress) when a
    // run would actually be lost. Otherwise a freshly-launched UI looks hung.
    if (countActiveRuns() === 0) {
      void shutdown(130)
      return
    }
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
  // The server is now listening: advertise it so the single registered MCP
  // bridge follows *this* port, even if the user switched it from the default.
  recordActiveServer(projectRoot, port)
  const url = `http://localhost:${port}`
  log(`Open ${url}`)
  log(`Project root: ${path.relative(process.cwd(), projectRoot) || '.'}`)
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
