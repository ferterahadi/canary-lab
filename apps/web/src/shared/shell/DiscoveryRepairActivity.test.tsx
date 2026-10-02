// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { DiscoveryRepairActivity } from './DiscoveryRepairActivity'
import type { DiscoveryRepairView } from '../api/discovery-repair'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('retains discovery task identity and updates its external outcome in the open viewer', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const startedAt = '2026-10-02T03:00:00Z'
  const repair: DiscoveryRepairView = {
    id: 'repair-one', feature: 'suite', featureDir: '/features/suite', status: 'repairing',
    owner: { kind: 'external', clientKind: 'codex', sessionId: 'conversation' },
    createdAt: startedAt, updatedAt: startedAt, heartbeatAt: new Date().toISOString(),
    message: 'Inspecting imports.', diagnostic: 'Missing module.', log: [], promptPath: '/prompt.md', promptReady: true,
  }
  try {
    await act(async () => root.render(<DiscoveryRepairActivity repair={repair} />))
    const header = () => host.querySelector('[data-activity-id="external:discovery-repair:repair-one:header"]')
    const start = host.querySelector('[data-activity-id="external:discovery-repair:repair-one:start"]')
    expect(header()?.textContent).toContain('Repairing test discovery')
    expect(header()?.querySelector('[data-testid="external-session-status"]')?.getAttribute('data-tone')).toBe('live')
    expect(start?.textContent).toContain('Running')
    await act(async () => root.render(<DiscoveryRepairActivity repair={{ ...repair, status: 'succeeded', endedAt: '2026-10-02T03:02:00Z', message: 'Discovered 4 tests.' }} />))
    expect(host.querySelector('[data-activity-id="external:discovery-repair:repair-one:start"]')).toBe(start)
    expect(header()?.querySelector('[data-testid="external-session-status"]')?.textContent).toBe('Completed · 2m 00s')
    expect(host.querySelector('[data-activity-id="external:discovery-repair:repair-one:end"]')?.textContent).toContain('Completed')
    expect(host.textContent).toContain('Discovered 4 tests.')
    expect(host.querySelector('[data-empty-reason]')).toBeNull()
  } finally { act(() => root.unmount()) }
})
