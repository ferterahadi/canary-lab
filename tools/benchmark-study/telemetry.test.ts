import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { measurements, startTelemetry, summarizeTelemetry, telemetryConfig } from './telemetry'

const batch = (name: string, duration = 120, extra = {}) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
  timeUnixNano: '1000000000', body: { stringValue: name }, attributes: Object.entries({ duration_ms: duration, ...extra }).map(([key, value]) =>
    ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } })),
}] }] }] })

it('keeps requests, stream waiting and tools separate; missing telemetry and retry coverage remain unknown', () => {
  const events = [
    ...measurements(batch('codex.api_request', 20, { attempt: 2, status: 429 }), 'codex'),
    ...measurements(batch('codex.websocket_event', 300), 'codex'),
    ...measurements(batch('codex.tool_result', 500), 'codex'),
  ]
  expect(summarizeTelemetry(events)).toEqual({ status: 'observed', requestEvents: 1, errorEvents: 1, retryEvents: 1,
    requestDurationMs: 20, streamDurationMs: 300, toolDurationMs: 500, rejectedBatches: 0 })
  expect(summarizeTelemetry([]).requestEvents).toBeNull()
  expect(summarizeTelemetry(measurements(batch('api_request'), 'claude')).retryEvents).toBeNull()
  expect(summarizeTelemetry(measurements(batch('api_error', 50, { attempt: 1 }), 'claude')).errorEvents).toBe(1)
  expect(measurements(batch('claude_code.user_prompt', 0, { prompt: 'private' }), 'claude')).toEqual([])
})

it('collects actual loopback HTTP exports, deduplicates retries and persists only measurement fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-telemetry-'))
  const collector = await startTelemetry(root, 'claude')
  try {
    const endpoint = collector.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!
    const body = JSON.stringify(batch('api_request', 250, { prompt: 'private content', 'user.email': 'secret@example.invalid' }))
    for (let i = 0; i < 2; i++) expect((await fetch(endpoint, { method: 'POST', body })).status).toBe(200)
    expect((await fetch(endpoint, { method: 'POST', body: 'malformed' })).status).toBe(400)
    const summary = await collector.close()
    expect(summary.requestEvents).toBe(1)
    expect(summary.requestDurationMs).toBe(250)
    expect(summary.rejectedBatches).toBe(1)
    const raw = fs.readFileSync(path.join(root, 'telemetry-events.jsonl'), 'utf8')
    expect(raw).not.toContain('private content')
    expect(raw).not.toContain('secret@example.invalid')
    expect(telemetryConfig(endpoint).codexArgs.join(' ')).toContain('protocol="json"')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
