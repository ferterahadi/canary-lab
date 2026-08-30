import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { agentProbeRoutes } from './agent-probe'
import type { AgentProbeSnapshot } from '../../agent-sessions/logic/agent-probe'

const snapshot: AgentProbeSnapshot = {
  probedAt: '2026-08-28T00:00:00.000Z',
  claude: { agent: 'claude', state: 'ok', binaryPath: '/opt/bin/claude', version: '2.1.250', models: [], remedy: null },
  codex: { agent: 'codex', state: 'missing', binaryPath: null, version: null, models: [], remedy: 'Install the Codex CLI (`codex`), or point CANARY_LAB_CODEX_BIN at it.' },
}

describe('GET /api/agent-probe', () => {
  it('returns the probe snapshot and passes the fresh flag through', async () => {
    const probe = vi.fn(async (_force?: boolean) => snapshot)
    const app = Fastify()
    await app.register(async (a) => { await agentProbeRoutes(a, { probeService: { snapshot: probe } }) })
    await app.ready()
    try {
      const cached = await app.inject({ method: 'GET', url: '/api/agent-probe' })
      expect(cached.statusCode).toBe(200)
      expect(cached.json()).toEqual(snapshot)
      expect(probe).toHaveBeenLastCalledWith(false)

      await app.inject({ method: 'GET', url: '/api/agent-probe?fresh=1' })
      expect(probe).toHaveBeenLastCalledWith(true)
    } finally {
      await app.close()
    }
  })

  it('builds the default subprocess-backed service when none is injected', async () => {
    // Registration only, no request fired: the default service probes the
    // machine's real CLIs, which are not test fixtures. This pins that omitting
    // deps constructs the default wiring instead of throwing at register time.
    const app = Fastify()
    await app.register(async (a) => { await agentProbeRoutes(a) })
    await app.ready()
    await app.close()
    expect(app.hasRoute({ method: 'GET', url: '/api/agent-probe' })).toBe(true)
  })
})
