import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { agentSessionStreamRoutes } from './agent-session-stream'
import { runsRoutes } from '../../runs/routes/runs'
import { RunStore } from '../../runs/logic/run-store'
import { createRegistry } from '../../runs/logic/run-registry'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import { claudeSessionLogPath } from '../logic/agent-session-paths'

const tempDir = trackTempDirs('run-session-stream-')
let app: FastifyInstance
let runDir: string
beforeEach(async () => {
  const home = tempDir()
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(home, 'codex'))
  const logsDir = path.join(home, 'logs')
  const featuresDir = path.join(home, 'features')
  fs.mkdirSync(featuresDir)
  runDir = runDirFor(logsDir, 'run-1')
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'run-1', feature: 'checkout', featureDir: path.join(featuresDir, 'checkout'),
    startedAt: '2026-01-01T00:00:00Z', status: 'running', healCycles: 0, services: [],
  })
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  app = Fastify()
  await app.register(websocket)
  await app.register(runsRoutes, { store, featuresDir, startRun: async () => { throw new Error('unused') } })
  await app.register(agentSessionStreamRoutes, { store, logsDir })
  await app.ready()
})
afterEach(async () => { await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function writeLog(id: string, text: string, mtime: number) {
  const logPath = claudeSessionLogPath(runDir, id)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, JSON.stringify({ type: 'user', timestamp: 't', message: { content: text } }) + '\n')
  fs.utimesSync(logPath, mtime, mtime)
  return logPath
}

it('recovers a late log, agrees with REST, and stops its watcher on close', async () => {
  const frames: Array<{ type: string; sessionId?: string; event?: { text: string } }> = []
  const socket = await app.injectWS('/ws/runs/run-1/agent-session', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  const logPath = writeLog('late', 'first event', 100)
  await vi.waitFor(() => expect(frames.some((f) => f.sessionId === 'late')).toBe(true), { timeout: 3000 })
  expect((await app.inject('/api/runs/run-1/agent-session')).json().sessionId).toBe('late')
  fs.appendFileSync(logPath, JSON.stringify({ type: 'user', timestamp: 't2', message: { content: 'second event' } }) + '\n')
  await vi.waitFor(() => expect(frames.some((f) => f.event?.text === 'second event')).toBe(true))
  socket.terminate()
  for (const connection of app.websocketServer.clients) connection.terminate()
  await vi.waitFor(() => expect(app.websocketServer.clients.size).toBe(0))
  const watchers: fs.FSWatcher[] = []
  // Reconnecting attaches real watchers; capture their close methods to prove cleanup.
  const originalWatch = fs.watch
  const watch = vi.spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    const watcher = originalWatch(...args)
    vi.spyOn(watcher, 'close')
    watchers.push(watcher)
    return watcher
  }) as typeof fs.watch)
  const second = await app.injectWS('/ws/runs/run-1/agent-session')
  second.terminate()
  for (const connection of app.websocketServer.clients) connection.terminate()
  await vi.waitFor(() => {
    expect(watchers.length).toBeGreaterThan(0)
    for (const watcher of watchers) expect(watcher.close).toHaveBeenCalled()
  })
  watch.mockRestore()
  socket.close()
})

it('selects a newer discovered session over the persisted reference for both transports', async () => {
  const oldPath = writeLog('old', 'old event', 100)
  fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({ agent: 'claude', sessionId: 'old', logPath: oldPath }))
  writeLog('new', 'new event', 200)
  const frames: Array<{ type: string; sessionId?: string }> = []
  const socket = await app.injectWS('/ws/runs/run-1/agent-session', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  await vi.waitFor(() => expect(frames.some((f) => f.sessionId === 'new')).toBe(true))
  expect((await app.inject('/api/runs/run-1/agent-session')).json().sessionId).toBe('new')
  socket.close()
})
