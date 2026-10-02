import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { json } from './files'
import type { Agent, Telemetry } from './types'

interface Value { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
interface Attribute { key: string; value: Value }
interface LogRecord { timeUnixNano?: string; body?: Value; attributes?: Attribute[] }
interface Batch { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
export interface Measurement { name: string; timestamp: string; durationMs: number | null; attempt: number | null; error: boolean }
export interface StageBoundary { name: string; at: string; elapsedMs: number }

export function stageIntervals(events: StageBoundary[]) {
  const ordered = [...events].sort((a, b) => a.elapsedMs - b.elapsedMs)
  let stage = 'setup/boot'
  let tests = 0
  return ordered.slice(0, -1).map((event, index) => {
    if (event.name === 'playwright-started') stage = tests++ === 0 ? 'initial-test' : 'verification-cycle'
    else if (event.name === 'playwright-exit') stage = 'result-processing'
    else if (event.name === 'heal-cycle-started') stage = 'agent-diagnosis/edit'
    else if (event.name === 'signal-accepted') stage = 'signal/restart/readiness'
    else if (event.name === 'run-complete') stage = 'capture/cleanup'
    return { stage, from: event.at, to: ordered[index + 1].at, durationMs: ordered[index + 1].elapsedMs - event.elapsedMs }
  })
}
const number = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
const scalar = (value: Value): unknown => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue

export function measurements(batch: Batch, agent: Agent): Measurement[] {
  const result: Measurement[] = []
  for (const resource of batch.resourceLogs ?? []) for (const scope of resource.scopeLogs ?? []) for (const record of scope.logRecords ?? []) {
    const attrs = Object.fromEntries((record.attributes ?? []).map(({ key, value }) => [key, scalar(value)]))
    const rawName = String(attrs['event.name'] ?? scalar(record.body ?? {}) ?? '')
    const name = agent === 'claude' && !rawName.startsWith('claude_code.') ? `claude_code.${rawName}` : rawName
    if (!['codex.api_request', 'codex.websocket_request', 'codex.sse_event', 'codex.websocket_event', 'codex.tool_result',
      'claude_code.api_request', 'claude_code.api_error', 'claude_code.tool_result'].includes(name)) continue
    // Keep measurements only: exporter payloads can contain prompts, commands,
    // account identifiers and responses even when content logging is disabled.
    result.push({ name, timestamp: record.timeUnixNano ?? String(attrs['event.timestamp'] ?? ''),
      durationMs: number(attrs.duration_ms), attempt: number(attrs.attempt),
      error: name.endsWith('api_error') || attrs.success === false || attrs.success === 'false' || (number(attrs.status_code ?? attrs.status) ?? 0) >= 400 })
  }
  return result
}

export function summarizeTelemetry(events: Measurement[], rejectedBatches = 0): Telemetry {
  const requests = events.filter((e) => /(?:api_request|api_error|websocket_request)$/.test(e.name))
  const streams = events.filter((e) => /(?:sse_event|websocket_event)$/.test(e.name))
  const tools = events.filter((e) => e.name.endsWith('tool_result'))
  const duration = (rows: Measurement[]): number | null => rows.length && rows.every((e) => e.durationMs !== null) ? rows.reduce((n, e) => n + e.durationMs!, 0) : null
  return { status: events.length ? 'observed' : 'unavailable', requestEvents: requests.length || null,
    errorEvents: requests.length ? requests.filter((e) => e.error).length : null,
    retryEvents: requests.some((e) => e.attempt !== null) ? requests.filter((e) => e.attempt !== null && e.attempt > 1).length : null,
    requestDurationMs: duration(requests), streamDurationMs: duration(streams), toolDurationMs: duration(tools), rejectedBatches }
}

export function telemetryConfig(endpoint: string): { env: NodeJS.ProcessEnv; codexArgs: string[] } {
  return {
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      OTEL_LOGS_EXPORT_INTERVAL: '1000', OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_TOOL_DETAILS: '0',
      OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '0' },
    codexArgs: ['-c', `otel.exporter={otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json"}}`,
      '-c', 'otel.log_user_prompt=false', '-c', 'otel.log_agent_responses=false'],
  }
}

export async function startTelemetry(root: string, agent: Agent) {
  const events: Measurement[] = []
  const seen = new Set<string>()
  let rejectedBatches = 0
  const route = `/${randomUUID()}/v1/logs`
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== route) { res.writeHead(404).end(); return }
    let body = ''; let oversized = false
    req.on('data', (chunk: Buffer) => {
      if (oversized) return
      body += chunk.toString()
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) { oversized = true; rejectedBatches++; res.writeHead(413).end() }
    })
    req.on('end', () => {
      if (oversized) return
      try {
        const batch: Batch = JSON.parse(body)
        if (!Array.isArray(batch.resourceLogs)) throw new Error('Expected OTLP JSON logs')
        for (const event of measurements(batch, agent)) {
          // Retransmitted export batches must not inflate request counts. Do
          // not dedupe timestamp-less records, whose identities are unknown.
          const key = JSON.stringify(event)
          if (event.timestamp && seen.has(key)) continue
          if (event.timestamp) seen.add(key)
          events.push(event)
          fs.appendFileSync(path.join(root, 'telemetry-events.jsonl'), `${key}\n`)
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch { rejectedBatches++; res.writeHead(400).end() }
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { ...telemetryConfig(`http://127.0.0.1:${address.port}${route}`), close: async (): Promise<Telemetry> => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const result = summarizeTelemetry(events, rejectedBatches)
    json(path.join(root, 'telemetry-summary.json'), result)
    return result
  } }
}
