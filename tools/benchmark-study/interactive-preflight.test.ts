import { expect, it } from 'vitest'
import { hasProbeResult } from './interactive-preflight'

it('requires a successful native tool result rather than a completion claim or echoed prompt', () => {
  const row = (type: string, block: unknown): string => JSON.stringify({ type, message: { content: [block] } })
  expect(hasProbeResult(row('assistant', { type: 'text', text: 'PROBE_OK' }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(row('user', { type: 'text', text: 'PROBE_OK' }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(JSON.stringify({ type: 'user', message: { content: 'PROBE_OK' } }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult(row('user', { type: 'tool_result', content: 'PROBE_OK', is_error: true }), 'PROBE_OK')).toBe(false)
  expect(hasProbeResult('partial json\n' + row('user', { type: 'tool_result', content: 'PROBE_OK' }), 'PROBE_OK')).toBe(true)
})
