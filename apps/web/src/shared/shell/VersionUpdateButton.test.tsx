// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionUpdateButton } from './VersionUpdateButton'
import * as api from '../api/client'
import type { VersionStatus } from '../api/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

const render = (status: VersionStatus | null) => act(() => { root.render(<VersionUpdateButton status={status} />) })
const trigger = () => container.querySelector<HTMLButtonElement>('button')
const popover = () => document.body.querySelector<HTMLDivElement>('[role="dialog"]')
const openPopover = () => act(() => { trigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

const base: VersionStatus = {
  current: '1.4.1', latest: '1.4.1', updateAvailable: false, packageName: 'canary-lab', update: null,
}

describe('VersionUpdateButton', () => {
  it('renders nothing until the version check resolves', () => {
    render(null)
    expect(trigger()).toBeNull()
  })

  it('is a single icon with no inline copy in the footer (popover is portaled)', () => {
    render(base)
    // The footer only carries the icon button — no message text inline.
    expect(container.textContent?.trim()).toBe('')
    expect(popover()).toBeNull()
  })

  it('on the latest version: click opens a popover confirming it; no install call', () => {
    const spy = vi.spyOn(api, 'startVersionUpdate')
    render(base)
    expect(trigger()!.getAttribute('aria-label')).toContain('up to date')
    openPopover()
    const pop = popover()!
    expect(pop.textContent).toContain('Up to date')
    expect(pop.textContent).toContain('latest version')
    expect(pop.textContent).toContain('v1.4.1')
    expect(spy).not.toHaveBeenCalled()
  })

  it('update available: popover shows the delta + an Update button that starts the job', () => {
    const spy = vi.spyOn(api, 'startVersionUpdate').mockResolvedValue({
      jobId: 'current', status: 'running', targetVersion: '1.4.2', startedAt: 't', log: '',
    })
    render({ ...base, latest: '1.4.2', updateAvailable: true })
    openPopover()
    const pop = popover()!
    expect(pop.textContent).toContain('Update available')
    expect(pop.textContent).toContain('Update to v1.4.2')
    const updateBtn = [...pop.querySelectorAll('button')].find((b) => /Update to v1\.4\.2/.test(b.textContent ?? ''))!
    act(() => { updateBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('installed: popover says restart to apply and shows the command', () => {
    render({
      ...base,
      latest: '1.4.2',
      updateAvailable: true,
      update: { jobId: 'current', status: 'done', targetVersion: '1.4.2', startedAt: 't', endedAt: 't2', log: '' },
    })
    openPopover()
    const pop = popover()!
    expect(pop.textContent).toContain('Update installed')
    expect(pop.textContent).toContain('Restart')
    expect(pop.textContent).toContain('canary-lab ui')
  })

  it('offline: trigger still renders; popover explains the registry was unreachable', () => {
    render({ ...base, latest: null, updateAvailable: false })
    expect(trigger()).not.toBeNull()
    openPopover()
    expect(popover()!.textContent).toContain("Couldn't reach the npm registry")
  })

  it('Escape closes the popover', () => {
    render(base)
    openPopover()
    expect(popover()).not.toBeNull()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(popover()).toBeNull()
  })
})
