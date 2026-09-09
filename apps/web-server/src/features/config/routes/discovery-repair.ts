import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { DiscoveryRepairService } from '../logic/discovery-repair-service'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { pickAvailableHealAgent } from '../../runs/logic/runtime/auto-heal'
import { buildAgentSessionResponse, resolveManifestSessionRef } from '../../agent-sessions/logic/agent-session-log'
import { attachTail } from '../../agent-sessions/ws/agent-session-stream'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type { TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'

export interface DiscoveryRepairRouteDeps {
  projectRoot: string
  featuresDir: string
  logsDir: string
  workspaceEvents?: WorkspaceEventPublisher
  service?: DiscoveryRepairService
}

const startInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('internal') }),
  z.object({ kind: z.literal('external'), sessionId: z.string().min(1).max(200), clientKind: z.enum(['claude', 'codex', 'other']), conversationName: z.string().max(200).optional(), sessionUrl: z.string().url().refine((url) => /^(https?:|codex:|claude:)/.test(url)).optional() }),
])
const updateInput = z.object({ sessionId: z.string().min(1), action: z.enum(['progress', 'verify', 'blocked']), message: z.string().min(1).max(2000).optional() })

export async function discoveryRepairRoutes(app: FastifyInstance, deps: DiscoveryRepairRouteDeps): Promise<void> {
  const service = deps.service ?? new DiscoveryRepairService(deps)
  service.store.reconcileInterrupted(() => new Date().toISOString())
  const view = (id: string) => {
    const repair = service.get(id)
    return { ...repair, promptReady: fs.existsSync(repair.promptPath) }
  }
  app.get<{ Params: { name: string } }>('/api/features/:name/discovery-repairs', async (req) => service.list(req.params.name).map((r) => view(r.id)))
  app.get<{ Params: { id: string } }>('/api/discovery-repairs/:id', async (req) => view(req.params.id))
  app.post<{ Params: { name: string } }>('/api/features/:name/discovery-repairs', async (req, reply) => {
    const parsed = startInput.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid discovery repair owner' })
    const input = parsed.data
    if (input.kind === 'external') return reply.code(202).send(view(service.start(req.params.name, input).id))
    const preferred = loadProjectConfig(deps.projectRoot).healAgent
    const agent = pickAvailableHealAgent(preferred === 'manual' ? undefined : preferred)
    if (!agent) return reply.code(409).send({ error: 'No repair agent is available. Use the In your agent command.' })
    return reply.code(202).send(view(service.start(req.params.name, { kind: 'internal', agent }).id))
  })
  app.post<{ Params: { id: string } }>('/api/discovery-repairs/:id', async (req, reply) => {
    const parsed = updateInput.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid repair update' })
    const { sessionId, action, message } = parsed.data
    return view(service.update(req.params.id, sessionId, action, message).id)
  })
  const resolve = (id: string) => {
    const repair = service.get(id)
    return resolveManifestSessionRef(repair.sessionRef, { projectRoot: path.dirname(repair.promptPath), startedAt: repair.createdAt })
  }
  app.get<{ Params: { id: string } }>('/api/discovery-repairs/:id/agent-session', async (req) => {
    const ref = resolve(req.params.id)
    return ref ? buildAgentSessionResponse(ref) : { absent: true, reason: 'session-log-missing' }
  })
  app.get<{ Params: { id: string } }>('/ws/discovery-repairs/:id/agent-session', { websocket: true }, (socket, req) => {
    try { attachTail(socket, { ref: resolve(req.params.id), discoverRef: () => resolve(req.params.id) }) }
    catch (err) { socket.send(JSON.stringify({ type: 'error', error: String(err) })); socket.close() }
  })
  // Subscribe by feature even BEFORE an external agent starts. Every reconnect
  // sends the durable snapshot; workspace fan-out is never the sole trigger.
  app.get<{ Params: { name: string } }>('/ws/features/:name/discovery-repairs', { websocket: true }, (socket, req) => {
    const send = () => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ repairs: service.list(req.params.name).map((r) => view(r.id)) }))
    }
    const changed = (event: TaskStoreEvent) => { if (service.store.get(event.id)?.feature === req.params.name) send() }
    service.store.onEvent(changed)
    send()
    // A task-scoped snapshot also makes stale external contact visible while
    // no producer is writing, without repeatedly running discovery.
    const timer = setInterval(send, 15_000)
    socket.on('close', () => { clearInterval(timer); service.store.offEvent(changed) })
  })
}
