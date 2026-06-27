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
const btn = () => container.querySelector<HTMLButtonElement>('button')

const base: VersionStatus = {
  current: '1.4.0', latest: '1.4.0', updateAvailable: false, packageName: 'canary-lab', update: null,
}

describe('VersionUpdateButton', () => {
  it('renders nothing until the version check resolves', () => {
    render(null)
    expect(btn()).toBeNull()
  })

  it('on the latest version: stays visible and a click confirms it (no install call)', () => {
    const spy = vi.spyOn(api, 'startVersionUpdate')
    render(base)
    const b = btn()!
    expect(b).not.toBeNull()
    expect(b.disabled).toBe(false)
    expect(b.getAttribute('aria-label')).toContain('latest version')
    // No transient message before the click.
    expect(container.textContent).not.toContain("You're on the latest")
    act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain("You're on the latest version (v1.4.0)")
    expect(spy).not.toHaveBeenCalled()
  })

  it('when an update is available: click starts the self-update', () => {
    const spy = vi.spyOn(api, 'startVersionUpdate').mockResolvedValue({
      jobId: 'current', status: 'running', targetVersion: '1.4.1', startedAt: 't', log: '',
    })
    render({ ...base, latest: '1.4.1', updateAvailable: true })
    const b = btn()!
    expect(b.getAttribute('aria-label')).toContain('1.4.0 → v1.4.1')
    act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('after install: shows "restart to apply" and disables the button', () => {
    render({
      ...base,
      latest: '1.4.1',
      updateAvailable: true,
      update: { jobId: 'current', status: 'done', targetVersion: '1.4.1', startedAt: 't', endedAt: 't2', log: '' },
    })
    const b = btn()!
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-label')).toContain('restart')
  })

  it('offline (no latest): still visible and a click says it could not check', () => {
    render({ ...base, latest: null, updateAvailable: false })
    const b = btn()!
    expect(b).not.toBeNull()
    act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain("couldn't reach the registry")
  })
})
