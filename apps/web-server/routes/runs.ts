import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { PlaywrightArtifact } from '../lib/run-store'
import type { RunStore, OrchestratorLike } from '../lib/run-store'
import { loadFeatures } from '../lib/feature-loader'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import { createAssertionExport } from '../lib/test-review-export'

export interface RunsRouteDeps {
  featuresDir: string
  /** Single source of truth for run state. Routes read + mutate exclusively
   *  through this — no direct manifest/index file access. */
  store: RunStore
  // Factory: given a feature name, build + start an orchestrator. Returns the
  // runId synchronously after `start()` is in flight (the factory awaits the
  // initial spawn but not test completion). Injected so tests can stub it.
  startRun(feature: string, env?: string): Promise<OrchestratorLike>
}

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get<{ Querystring: { feature?: string } }>('/api/runs', async (req) => {
    return deps.store.list({ feature: req.query.feature })
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    return detail
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/assertion.html', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if (!isTerminalRun(detail.manifest.status)) {
      reply.code(409)
      return { error: 'assertion export is available after the run finishes' }
    }
    const videos = assertionVideos(
      detail.playwrightArtifacts,
      buildRunPaths(runDirFor(deps.store.logsDir, detail.runId)).playwrightArtifactsDir,
      detail.runId,
    )
    const archiveBase = `canary-lab-assertion-${safeFilename(detail.manifest.feature)}-${safeFilename(detail.runId)}`
    const exported = await createAssertionExport(detail, { videoLinksByTestName: videoLinksByTestName(videos) })
    const zip = createZip([
      { filename: 'assertion.html', data: Buffer.from(exported.html, 'utf8') },
      ...exported.assets,
      ...videos.map((video) => ({ filename: video.filename, data: fs.readFileSync(video.path) })),
    ])
    reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${archiveBase}.zip"`)
    return reply.send(zip)
  })

  app.get<{ Params: { runId: string; '*': string } }>('/api/runs/:runId/artifacts/*', async (req, reply) => {
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    const artifactsDir = buildRunPaths(runDir).playwrightArtifactsDir
    const requested = path.resolve(artifactsDir, req.params['*'])
    const rel = path.relative(artifactsDir, requested)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      reply.code(400)
      return { error: 'invalid artifact path' }
    }
    try {
      const stat = fs.statSync(requested)
      if (!stat.isFile()) {
        reply.code(404)
        return { error: 'artifact not found' }
      }
    } catch {
      reply.code(404)
      return { error: 'artifact not found' }
    }
    reply.type(contentTypeFor(requested))
    return reply.send(fs.createReadStream(requested))
  })

  app.post<{ Body: { feature?: string; env?: string } }>('/api/runs', async (req, reply) => {
    const feature = req.body?.feature
    if (typeof feature !== 'string' || feature.length === 0) {
      reply.code(400)
      return { error: 'feature required' }
    }
    const features = loadFeatures(deps.featuresDir)
    const featureCfg = features.find((f) => f.name === feature)
    if (!featureCfg) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    // env is optional only when the feature didn't declare any. Otherwise it
    // must be one of feature.envs (default: first entry).
    const declared = featureCfg.envs ?? []
    const env = declared.length > 0 ? (req.body?.env ?? declared[0]) : undefined
    if (declared.length > 0 && (typeof env !== 'string' || !declared.includes(env))) {
      reply.code(400)
      return { error: `env must be one of: ${declared.join(', ')}` }
    }
    try {
      const orch = await deps.startRun(feature, env)
      deps.store.registry.set(orch.runId, orch)
      reply.code(201)
      return { runId: orch.runId }
    } catch (err) {
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      reply.code(code)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Mid-Run Heal: manual interruption. Looks up the orchestrator in the
  // registry, asks it to SIGTERM Playwright + jump into the heal cycle.
  // 404 when unknown, 409 with a reason when pausing is meaningless,
  // 202 + status payload on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/pause-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.pauseAndHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'healing', failureCount: result.failureCount }
  })

  // Cancel an in-flight heal cycle. SIGTERMs the agent pty, breaks the heal
  // loop, appends a journal entry. 404 when unknown, 409 with a reason when
  // there's nothing to cancel, 202 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.cancelHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'cancelled' }
  })

  // Live interject — pipe a line of text to the running heal agent's stdin
  // so the user can guide the agent without restarting the cycle. 404 when
  // unknown, 409 when there's no agent running for this run.
  app.post<{ Params: { runId: string }; Body: { data: string } }>(
    '/api/runs/:runId/agent-input',
    async (req, reply) => {
      const orch = deps.store.registry.get(req.params.runId)
      if (!orch) {
        reply.code(404)
        return { error: 'run not active' }
      }
      if (typeof req.body?.data !== 'string') {
        reply.code(400)
        return { error: 'data must be a string' }
      }
      if (!orch.interjectHealAgent) {
        reply.code(409)
        return { reason: 'no-agent-running' }
      }
      const result = await orch.interjectHealAgent(req.body.data)
      if (!result.ok) {
        reply.code(result.reason === 'spawn-failed' ? 500 : 409)
        return { reason: result.reason }
      }
      reply.code(202)
      return { status: 'sent' }
    },
  )

  // POST /api/runs/:runId/abort — explicit abort of an active run. Stops
  // the orchestrator (kills Playwright + heal agent + service ptys) and
  // marks the manifest 'aborted'. The run is preserved in history so the
  // user can audit the logs after. 404 when not active, 204 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/abort', async (req, reply) => {
    const result = await deps.store.abort(req.params.runId)
    if (!result.ok) {
      reply.code(404)
      return { error: 'run not active' }
    }
    reply.code(204)
    return ''
  })

  // DELETE /api/runs/:runId — hard-remove a terminal run from history.
  // The action-matrix policy (active runs must be aborted first) lives in
  // `RunStore.delete`; the route just maps the structured failure into HTTP
  // status codes.
  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const result = deps.store.delete(req.params.runId)
    if (!result.ok) {
      if (result.reason === 'not-found') {
        reply.code(404)
        return { error: 'run not found' }
      }
      reply.code(409)
      return {
        error: result.reason === 'active'
          ? 'run is still active; abort it first'
          : 'run is still active; reap or abort first',
      }
    }
    reply.code(204)
    return ''
  })
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

function isTerminalRun(status: string): boolean {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

function assertionVideos(
  groups: Array<{ testName: string; artifacts: PlaywrightArtifact[] }> | undefined,
  artifactsDir: string,
  runId: string,
): Array<{ filename: string; path: string; testName: string }> {
  const videos = (groups ?? [])
    .flatMap((group) => group.artifacts.map((artifact) => ({ artifact, testName: group.testName })))
    .map(({ artifact, testName }) => {
      const filePath = path.resolve(artifactsDir, artifact.path)
      const rel = path.relative(artifactsDir, filePath)
      return { artifact, filePath, testName, valid: !rel.startsWith('..') && !path.isAbsolute(rel) }
    })
    .filter(({ artifact, filePath, valid }) =>
      valid && artifact.kind === 'video' && fs.existsSync(filePath) && fs.statSync(filePath).isFile())
  const used = new Set<string>()
  return videos.map(({ artifact, filePath, testName }, idx) => {
    const ext = path.extname(filePath) || extensionForContentType(artifact.contentType) || '.webm'
    const suffix = videos.length === 1 ? '' : `-${idx + 1}`
    let filename = `${safeFilename(runId)}${suffix}${ext}`
    let dedupe = 2
    while (used.has(filename)) {
      filename = `${safeFilename(runId)}${suffix}-${dedupe}${ext}`
      dedupe += 1
    }
    used.add(filename)
    return { filename, path: filePath, testName }
  })
}

function videoLinksByTestName(videos: Array<{ filename: string; testName: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const video of videos) out[video.testName] = [...(out[video.testName] ?? []), video.filename]
  return out
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  if (contentType === 'video/mp4') return '.mp4'
  if (contentType === 'video/webm') return '.webm'
  return undefined
}

interface ZipEntry {
  filename: string
  data: Buffer
}

function createZip(entries: ZipEntry[]): Buffer {
  const fileRecords: Buffer[] = []
  const centralRecords: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.filename, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const fileRecord = Buffer.concat([local, name, entry.data])
    fileRecords.push(fileRecord)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralRecords.push(Buffer.concat([central, name]))
    offset += fileRecord.length
  }
  const centralOffset = offset
  const centralDirectory = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...fileRecords, centralDirectory, end])
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
