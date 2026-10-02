import { describe, expect, it } from 'vitest'
import { serviceLogsFromManifest } from './service-log-paths'

describe('serviceLogsFromManifest', () => {
  it('preserves legacy values, order and duplicates before current log paths', () => {
    const manifest = { serviceLogs: ['old.log', '', 'same.log'], services: [
      { logPath: 'same.log' }, {}, { logPath: '' }, { logPath: ' ' }, { logPath: 'new.log' },
    ] }
    expect(serviceLogsFromManifest(manifest)).toEqual(['old.log', '', 'same.log', 'same.log', ' ', 'new.log'])
    expect(manifest.serviceLogs).toEqual(['old.log', '', 'same.log'])
  })

  it('ignores absent or non-array collections and non-string current paths', () => {
    expect(serviceLogsFromManifest({})).toEqual([])
    const malformed = JSON.parse('{"serviceLogs":{},"services":"not an array"}')
    expect(serviceLogsFromManifest(malformed)).toEqual([])
    expect(serviceLogsFromManifest(JSON.parse('{"services":[{"logPath":null},{"logPath":42}]}'))).toEqual([])
  })
})
