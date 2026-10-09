import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { createServer } from './server'
import { PortifyRunStore } from './features/portify/logic/runtime/store'
import type { PortifyManifest } from '../../../shared/portify-index'
import { writeManifest, writeRunsIndex } from './features/runs/logic/runtime/manifest'
import type { WorkspaceStreamFrame } from '../../../shared/workspace-events'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cleanup-server-')

it('publishes cleanup changes from registered mutations to an already-open workspace socket', async () => {
  const projectRoot = tempDir()
  const logsDir = path.join(projectRoot, 'logs')
  const runDir = path.join(logsDir, 'runs', 'example-run')
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'example-run', feature: 'example', startedAt: '2026-01-01T00:00:00Z', status: 'passed', healCycles: 0, services: [],
  })
  writeRunsIndex(logsDir, [{ runId: 'example-run', feature: 'example', startedAt: '2026-01-01T00:00:00Z', status: 'passed', healCycles: 0 }])
  new PortifyRunStore(logsDir).save({ workflowId: 'example-workflow', feature: 'example', status: 'saved', startedAt: '2026-01-01T00:00:00Z' } as PortifyManifest)
  const { app } = await createServer({ projectRoot })
  await app.ready()
  const frames: WorkspaceStreamFrame[] = []
  const socket = await app.injectWS('/ws/workspace', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WorkspaceStreamFrame)),
  })
  try {
    const removedRun = await app.inject({ method: 'DELETE', url: '/api/runs/example-run' })
    const removedWorkflow = await app.inject({ method: 'DELETE', url: '/api/portify/example-workflow' })
    expect(removedRun.statusCode).toBe(204)
    expect(removedWorkflow.statusCode).toBe(200)
    await expect.poll(() => frames.filter((frame) => frame.type === 'cleanup-changed').map((frame) => frame.resource).sort(), { timeout: 5000 }).toEqual(['portify', 'runs', 'worktrees', 'worktrees'])
    expect((await app.inject('/api/cleanup/runs')).json().runs).toEqual([])
    expect((await app.inject('/api/cleanup/portify')).json().workflows).toEqual([])
  } finally {
    socket.terminate()
    await app.close()
  }
}, 10_000)
