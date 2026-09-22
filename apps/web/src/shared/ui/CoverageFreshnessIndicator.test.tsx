// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { CoverageFreshness } from '@shared/coverage/freshness'
import { CoverageFreshnessIndicator, coverageWarning } from './CoverageFreshnessIndicator'

const fresh: CoverageFreshness = { state: 'current', revision: 'a', checkedAt: '2026-09-17', reasons: [], changedTests: [], latestRunFailed: false }
describe('compact coverage freshness', () => {
  it.each([
    [{ ...fresh, state: 'stale' as const }, 'Coverage out of date'],
    [{ ...fresh, state: 'unavailable' as const }, 'Coverage inputs unavailable'],
    [{ ...fresh, state: 'updating' as const }, 'Coverage update in progress'],
    [{ ...fresh, state: 'not-measured' as const }, 'Coverage not measured'],
    [{ ...fresh, latestRunFailed: true }, 'Latest run has failures'],
  ])('explains %s without claiming a new calculation', (snapshot, label) => {
    expect(coverageWarning(snapshot, true)).toContain(label)
  })
  it('keeps an outdated-coverage explanation brief and clear', () => {
    expect(coverageWarning({
      ...fresh,
      state: 'stale',
      reasons: ['Requirements changed after this coverage was generated.'],
    }, true)).toBe([
      'Coverage out of date.',
      'Requirements changed after this coverage was generated.',
      'Showing results from the last calculation.',
    ].join(' '))
  })
  it('explains missing snapshots, disconnected reads, reasons and clean recovery', () => {
    expect(coverageWarning(undefined, true)).toContain('Coverage freshness unconfirmed')
    expect(coverageWarning(fresh, false, 'offline')).toContain('offline')
    expect(coverageWarning(fresh, false)).toContain('Checking current inputs')
    expect(coverageWarning({ ...fresh, state: 'stale', reasons: ['tests changed'] }, true)).toContain('tests changed')
    expect(coverageWarning(fresh, true)).toBeUndefined()
  })
  it('provides the same warning on keyboard focus and hover, and disappears after recovery', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      act(() => root.render(<CoverageFreshnessIndicator message="Coverage out of date" />))
      const icon = host.querySelector<HTMLElement>('[role="img"]')!
      expect(icon.getAttribute('aria-label')).toBe('Coverage out of date')
      act(() => icon.focus())
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Coverage out of date')
      act(() => icon.blur())
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
      act(() => icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Coverage out of date')
      act(() => root.render(<CoverageFreshnessIndicator />))
      expect(host.textContent).toBe('')
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
    } finally { act(() => root.unmount()); host.remove() }
  })
})
