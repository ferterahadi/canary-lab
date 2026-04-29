// Thin CLI glue around `createServer`. Coverage is excluded — boots Fastify
// against the real project root and binds a port, neither of which is
// deterministically testable without a real listen() call.

import path from 'path'
import { createServer } from '../apps/web-server/server'
import { getProjectRoot } from '../shared/runtime/project-root'

export interface UiCommandOptions {
  port?: number
  projectRoot?: string
  // Injected for tests / future programmatic use.
  log?: (msg: string) => void
}

export async function runUi(argv: string[], opts: UiCommandOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const portFromArgs = parsePort(argv)
  const port = portFromArgs ?? opts.port ?? 7421
  const projectRoot = opts.projectRoot ?? getProjectRoot()
  const { app } = await createServer({ projectRoot })
  await app.listen({ port, host: '127.0.0.1' })
  log(`Open http://localhost:${port}`)
  log(`Project root: ${path.relative(process.cwd(), projectRoot) || '.'}`)
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
