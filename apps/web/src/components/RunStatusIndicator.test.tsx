import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunStatusIndicator } from './RunStatusIndicator'
import type { RunStatus } from '../api/types'

// We don't have @testing-library/react in this workspace and the vitest
// environment is `node`, so use renderToStaticMarkup to assert the output
// HTML. That's enough to verify the dot colour and the pulse halo presence.

describe('RunStatusIndicator', () => {
  it.each([
    ['passed',  'bg-emerald-500'],
    ['failed',  'bg-rose-500'],
    ['aborted', 'bg-zinc-400'],
    ['running', 'bg-sky-500'],
    ['healing', 'bg-amber-500'],
  ] as const)('renders %s with dot class %s', (status, dotClass) => {
    const html = renderToStaticMarkup(<RunStatusIndicator status={status as RunStatus} />)
    expect(html).toContain(dotClass)
    expect(html).toContain(`data-status="${status}"`)
    expect(html).toContain(status) // label text
  })

  it.each([['running'], ['healing']] as const)('renders a pulse halo for %s', (status) => {
    const html = renderToStaticMarkup(<RunStatusIndicator status={status as RunStatus} />)
    expect(html).toContain('animate-ping')
  })

  it.each([['passed'], ['failed'], ['aborted']] as const)('does NOT render a pulse halo for %s', (status) => {
    const html = renderToStaticMarkup(<RunStatusIndicator status={status as RunStatus} />)
    expect(html).not.toContain('animate-ping')
  })

  it('renders nothing button-shaped: no border, no background pill', () => {
    const html = renderToStaticMarkup(<RunStatusIndicator status="failed" />)
    expect(html).not.toMatch(/\bborder(-|"|\s)/)
    expect(html).not.toMatch(/\bbg-rose-500\/15\b/) // old badge fill
  })

  it('falls back to the aborted palette for an unknown status (defensive)', () => {
    const html = renderToStaticMarkup(<RunStatusIndicator status={'mystery' as RunStatus} />)
    expect(html).toContain('bg-zinc-400')
  })
})
