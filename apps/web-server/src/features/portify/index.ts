import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { portifyRoutes } from './routes/portify'
import { portifyStreamRoutes } from './ws/portify-stream'
import { createPortifyRunner } from './logic/runtime/runner'
import { portifyDir } from './logic/runtime/paths'
import { loadFeatures } from '../../shared/feature-loader'
import { pickAvailableHealAgent } from '../runs/logic/runtime/auto-heal'
import {
  resolveWorkflowAgentRef,
  buildAgentSessionResponse,
} from '../agent-sessions/logic/agent-session-log'

/**
 * Port-ification workflow: rewrite a feature's apps to use injectable ports,
 * proven by a concurrent double-boot, ending at a user commit.
 *
 * The runner is built here rather than at boot because nothing outside this
 * feature drives it. Agent selection pins the chosen CLI and ignores the global
 * heal-agent setting, same policy as benchmark — a portify run should not change
 * behaviour because someone switched their default agent.
 */
export interface PortifyFeature {
  /**
   * The in-process runner behind routes/portify.ts. Exposed because the MCP
   * layer drives the same workflow (external-producer half only) and must reuse
   * this instance — a second runner would mean two owners of the same store.
   */
  runner: ReturnType<typeof createPortifyRunner>
}

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<PortifyFeature> {
  const runner = createPortifyRunner({
    logsDir: ctx.logsDir,
    store: ctx.portifyStore,
    ptyFactory: ctx.ptyFactory,
    loadFeatures: () => loadFeatures(ctx.featuresDir),
    pickAgent: (preferred) => pickAvailableHealAgent(preferred),
    now: () => new Date().toISOString(),
  })

  await app.register(portifyRoutes, {
    store: ctx.portifyStore,
    logsDir: ctx.logsDir,
    startPortify: runner.startPortify,
    savePortify: runner.save,
    cancelPortify: runner.cancel,
    revisePortify: runner.revise,
    removePortify: runner.remove,
    workspaceEvents: ctx.workspaceEvents,
    projectRoot: ctx.projectRoot,
    loadAgentSession: (id) => {
      const ref = resolveWorkflowAgentRef(portifyDir(ctx.logsDir, id))
      return ref ? buildAgentSessionResponse(ref) : null
    },
  })
  await app.register(portifyStreamRoutes, { store: ctx.portifyStore })

  return { runner }
}
