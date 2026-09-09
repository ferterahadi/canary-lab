import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { describe, expect, it, vi } from 'vitest'
import { discoveryRepairRoutes } from './discovery-repair'
import { DiscoveryRepairService } from '../logic/discovery-repair-service'

describe('discovery repair transport', () => {
  it('pushes external creation, milestones and terminal state to an already-open Tests stream and replays on reconnect', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-stream-'))
    const featuresDir = path.join(projectRoot, 'features')
    const dir = path.join(featuresDir, 'suite')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'feature.config.cjs'), "module.exports={config:{name:'suite',featureDir:__dirname,repos:[],envs:[]}}")
    const listTests = vi.fn(async (_f: unknown, diagnostics: (message: string) => void) => { diagnostics('missing import'); return null })
    const deps = { projectRoot, featuresDir, logsDir: path.join(projectRoot, 'logs'), listTests }
    const service = new DiscoveryRepairService(deps)
    const app = Fastify()
    await app.register(websocket)
    await app.register(discoveryRepairRoutes, { ...deps, service })
    await app.ready()
    const socket = await app.injectWS('/ws/features/suite/discovery-repairs')
    const snapshots: Array<{ repairs: Array<{ status: string; message: string }> }> = []
    socket.on('message', (raw) => snapshots.push(JSON.parse(raw.toString())))
    try {
      const started = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } })
      expect(started.statusCode).toBe(202)
      const id = started.json().id
      await service.settled()
      await app.inject({ method: 'POST', url: `/api/discovery-repairs/${id}`, payload: { sessionId: 'owner', action: 'progress', message: 'Inspecting imports' } })
      await vi.waitFor(() => expect(snapshots.some((s) => s.repairs[0]?.message === 'Inspecting imports')).toBe(true))
      await app.inject({ method: 'POST', url: `/api/discovery-repairs/${id}`, payload: { sessionId: 'owner', action: 'verify' } })
      await service.settled()
      await vi.waitFor(() => expect(snapshots.some((s) => s.repairs[0]?.status === 'failed')).toBe(true))
      socket.close()
      let replay: string | undefined
      const resumed = await app.injectWS('/ws/features/suite/discovery-repairs', {}, { onInit: (ws) => { ws.on('message', (raw) => { replay = raw.toString() }) } })
      await vi.waitFor(() => expect(replay).toContain('missing import'))
      resumed.close()
      const invalid = await app.inject({ method: 'POST', url: '/api/features/suite/discovery-repairs', payload: { kind: 'external', sessionId: '', clientKind: 'codex' } })
      expect(invalid.statusCode).toBe(400)
    } finally { socket.close(); await app.close(); fs.rmSync(projectRoot, { recursive: true, force: true }) }
  })
})
