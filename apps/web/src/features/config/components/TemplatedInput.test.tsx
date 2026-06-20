// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnvsetsIndex, getFeatureConfigDoc, type ParsedConfigDoc } from '../../../api/client'
import { TemplatedInput } from './TemplatedInput'

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ...actual,
    getEnvsetsIndex: vi.fn(),
    getEnvsetSlot: vi.fn(),
    getFeatureConfigDoc: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getEnvsetsIndex).mockReset().mockResolvedValue({ envs: [{ name: 'local', slots: ['app.env'] }] })
  vi.mocked(getFeatureConfigDoc).mockReset().mockResolvedValue(docWithPorts())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('.fixed').forEach((el) => el.remove())
})

describe('TemplatedInput', () => {
  it('renders a ${port.<slot>} token as a pill', async () => {
    await act(async () => {
      root.render(
        <TemplatedInput value="http://localhost:${port.gateway}" onChange={vi.fn()} feature="f" namespaces={['port']} />,
      )
    })
    const pill = container.querySelector('[data-pill]')
    expect(pill).not.toBeNull()
    expect(pill!.getAttribute('data-slot')).toBe('port')
    expect(pill!.getAttribute('data-key')).toBe('gateway')
  })

  it('port-only picker lists declared port slots and inserts on pick', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        <TemplatedInput value="http://localhost:${port.gateway}" onChange={onChange} feature="f" namespaces={['port']} />,
      )
    })
    // Clicking the pill opens the picker (no Selection APIs needed).
    const pill = container.querySelector('[data-pill]') as HTMLElement
    await act(async () => {
      pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    // Picker is portaled to document.body and lists port slots, no envset slots.
    expect(document.body.textContent).toContain('Pick a port slot')
    expect(document.body.textContent).toContain('${port.gateway}')
    expect(document.body.textContent).toContain('${port.report}')
    expect(getEnvsetsIndex).not.toHaveBeenCalled()

    // Picking a slot replaces the pill and serializes back into the value.
    const option = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '${port.report}')!
    await act(async () => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onChange).toHaveBeenCalledWith('http://localhost:${port.report}')
  })

  it('port-only picker explains when no slots are declared', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    await act(async () => {
      root.render(
        <TemplatedInput value="x ${port.gateway}" onChange={vi.fn()} feature="f" namespaces={['port']} />,
      )
    })
    const pill = container.querySelector('[data-pill]') as HTMLElement
    await act(async () => {
      pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(document.body.textContent).toContain('No port slots declared')
  })
})

function docWithPorts(): ParsedConfigDoc {
  return {
    path: '/features/f/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name: 'f',
        repos: [
          {
            name: 'svc',
            localPath: '~/svc',
            startCommands: [
              { command: 'yarn start', ports: [{ name: 'gateway', env: 'GATEWAY_PORT' }, { name: 'report' }] },
            ],
          },
        ],
      },
      complexFields: [],
      source: '',
    },
  }
}

function docNoPorts(): ParsedConfigDoc {
  return {
    path: '/features/f/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: { name: 'f', repos: [{ name: 'svc', localPath: '~/svc', startCommands: [{ command: 'yarn start' }] }] },
      complexFields: [],
      source: '',
    },
  }
}
