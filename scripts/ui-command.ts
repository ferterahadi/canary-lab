// Thin CLI glue around `createServer`. Coverage is excluded — boots Fastify
// against the real project root and binds a port, neither of which is
// deterministically testable without a real listen() call.

import path from 'path'
import { createServer } from '../apps/web-server/server'
import { getProjectRoot } from '../shared/runtime/project-root'
import { openBrowser } from '../apps/web-server/lib/open-browser'

export interface UiCommandOptions {
  port?: number
  projectRoot?: string
  // Injected for tests / future programmatic use.
  log?: (msg: string) => void
  exit?: (code: number) => void
}

export async function runUi(argv: string[], opts: UiCommandOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const portFromArgs = parsePort(argv)
  const port = portFromArgs ?? opts.port ?? 7421
  const noOpen = argv.includes('--no-open')
  const projectRoot = opts.projectRoot ?? getProjectRoot()
  const { app, runStore, revertAllEnvsets } = await createServer({ projectRoot })

  // Stop active runs and revert any in-flight envset swaps if the user kills
  // the UI server before their runs finish. `orch.stop()` owns the process
  // cleanup path for service PTYs, Playwright, and heal agents.
  let cleanedUp = false
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return
    cleanedUp = true
    await runStore.abortAllActiveOrStale()
    revertAllEnvsets()
  }
  const shutdown = async (code: number): Promise<void> => {
    await cleanup()
    try { await app.close() } catch { /* already closed or never fully opened */ }
    exit(code)
  }
  process.once('SIGINT', () => { void shutdown(130) })
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

function parsePort(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (Number.isFinite(n)) return n
    } else if (a.startsWith('--port=')) {
      const n = parseInt(a.slice('--port='.length), 10)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}
