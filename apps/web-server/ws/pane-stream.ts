import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { PaneBroker, PaneId, PaneSubscriber } from '../lib/pane-broker'
import type { OrchestratorRegistry } from '../lib/run-store'
import { readManifest } from '../../../shared/e2e-runner/manifest'
import { buildRunPaths, runDirFor } from '../../../shared/e2e-runner/run-paths'

// Wires Fastify's WebSocket plugin to the per-run PaneBroker. Coverage is
// excluded for this module — the wire-up is too thin to test deterministically
// without a real WebSocket round-trip. The buffer + broker logic underneath
// is fully covered.
//
// When `brokerFor(runId)` returns null (run finished, broker reaped, or run
// belongs to a previous server process), we fall back to streaming the on-disk
// log file once and closing the socket. This lets users audit completed runs
// indefinitely — until they explicitly delete them.

export interface PaneStreamDeps {
  registry: OrchestratorRegistry
  // Per-run broker lookup. Production builds this when a run starts; tests
  // bypass this module entirely.
  brokerFor(runId: string): PaneBroker | null
  // Where on-disk logs live. Used to build the fallback file path when the
  // broker is gone. Required so the same module can serve historical runs.
  logsDir: string
}

export async function paneStreamRoutes(
  app: FastifyInstance,
  deps: PaneStreamDeps,
): Promise<void> {
  app.get<{ Params: { runId: string; paneId: string } }>(
    '/ws/run/:runId/pane/:paneId',
    { websocket: true },
    (socket, req) => {
      const { runId, paneId } = req.params
      const broker = deps.brokerFor(runId)
      if (broker) {
        const sub: PaneSubscriber = {
          send: (msg) => {
            try { socket.send(JSON.stringify(msg)) } catch { /* socket closed */ }
          },
          close: () => {
            try { socket.close() } catch { /* already closed */ }
          },
        }
        const unsub = broker.subscribe(paneId as PaneId, sub)
        // Live interject: forward `agent-input` frames on the agent pane to
        // the heal-agent pty's stdin. Other paneIds ignore the message.
        if (paneId === 'agent') {
          socket.on('message', (raw) => {
            let parsed: unknown
            try { parsed = JSON.parse(raw.toString()) } catch { return }
            if (
              parsed && typeof parsed === 'object'
              && (parsed as { type?: unknown }).type === 'agent-input'
              && typeof (parsed as { data?: unknown }).data === 'string'
            ) {
              const orch = deps.registry.get(runId)
              // Fire-and-forget — the WS path has no client-visible response
              // channel for the structured failure; the HTTP route is the
              // canonical interject API.
              void orch?.interjectHealAgent?.((parsed as { data: string }).data)
            }
          })
        }
        socket.on('close', () => unsub())
        return
      }

      // Fallback: replay the on-disk log file for finished/historical runs.
      const filePath = resolveLogPath(deps.logsDir, runId, paneId)
      if (!filePath) {
        socket.send(JSON.stringify({ type: 'error', error: 'unknown pane' }))
        socket.close()
        return
      }
      try {
        const chunk = fs.readFileSync(filePath, 'utf-8')
        if (chunk.length > 0) {
          socket.send(JSON.stringify({ type: 'data', chunk }))
        }
        socket.send(JSON.stringify({ type: 'exit', code: 0 }))
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'log not available' }))
      } finally {
        socket.close()
      }
    },
  )
}

/**
 * Map a paneId to the log file produced for it during a run. Returns null
 * when the paneId is unknown or the run dir doesn't exist.
 *
 * - `service:<safeName>` → `svc-<safeName>.log`
 * - `playwright`         → `playwright.log`
 * - `agent`              → `agent-transcript.log`
 */
export function resolveLogPath(logsDir: string, runId: string, paneId: string): string | null {
  const runDir = runDirFor(logsDir, runId)
  if (!fs.existsSync(runDir)) return null
  const paths = buildRunPaths(runDir)

  if (paneId === 'playwright') return paths.playwrightStdoutPath
  if (paneId === 'agent') return paths.agentTranscriptPath

  if (paneId.startsWith('service:')) {
    const safeName = paneId.slice('service:'.length)
    if (!safeName) return null
    // Confirm the service exists in the manifest — defensive: pane ids are
    // arbitrary strings and we don't want to expose arbitrary file reads.
    const manifest = readManifest(path.join(runDir, 'manifest.json'))
    if (!manifest) return null
    const found = manifest.services.find((s) => s.safeName === safeName)
    if (!found) return null
    return paths.serviceLog(safeName)
  }

  return null
}
