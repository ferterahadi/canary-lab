// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  McpPromoProvider,
  mcpPromoStorageKey,
  type McpPromoAction,
  useMcpPromo,
} from './McpPromoContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('McpPromoProvider', () => {
  it('shows the promo before continuing an action', () => {
    const continued = vi.fn()
    renderGateProbe('create-feature', continued)

    act(() => {
      clickButton('Trigger create-feature')
    })

    expect(continued).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Run Canary Lab from Codex or Claude Desktop')
    expect(document.body.textContent).toContain('/canary-lab create a checkout test')

    act(() => {
      clickButton('Continue')
    })

    expect(continued).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Run Canary Lab from Codex or Claude Desktop')
  })

  it('cancels the original action when the user dismisses the promo', () => {
    const continued = vi.fn()
    renderGateProbe('run-test', continued)

    act(() => {
      clickButton('Trigger run-test')
    })
    act(() => {
      clickButton('X')
    })

    expect(continued).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Run Canary Lab from Codex or Claude Desktop')
  })

  it('stores per-action dismissal only after continuing with the checkbox checked', () => {
    const continued = vi.fn()
    renderGateProbe('run-test', continued)

    act(() => {
      clickButton('Trigger run-test')
    })
    act(() => {
      const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
      checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      clickButton('Continue')
    })

    expect(localStorage.getItem(mcpPromoStorageKey('run-test'))).toBe('true')
    expect(localStorage.getItem(mcpPromoStorageKey('export-evaluation'))).toBeNull()

    act(() => {
      clickButton('Trigger run-test')
      clickButton('Trigger export-evaluation')
    })

    expect(continued).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('/canary-lab export the selected evaluation')
  })

  it('falls back to showing the promo when localStorage is unavailable', () => {
    const continued = vi.fn()
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('blocked') },
        setItem: () => { throw new Error('blocked') },
      },
    })

    try {
      renderGateProbe('export-evaluation', continued)
      act(() => {
        clickButton('Trigger export-evaluation')
      })
      expect(continued).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Run Canary Lab from Codex or Claude Desktop')

      act(() => {
        clickButton('Continue')
      })
      expect(continued).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'localStorage', storage)
    }
  })

  it('throws when the hook is used outside the provider', () => {
    function Probe() {
      useMcpPromo()
      return null
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => {
      act(() => {
        root.render(<Probe />)
      })
    }).toThrow('useMcpPromo must be used inside McpPromoProvider')

    consoleError.mockRestore()
  })
})

function renderGateProbe(firstAction: McpPromoAction, onContinue: () => void): void {
  function Probe() {
    const { gatePromo } = useMcpPromo()
    return (
      <>
        <button type="button" onClick={() => gatePromo(firstAction, onContinue)}>
          Trigger {firstAction}
        </button>
        <button type="button" onClick={() => gatePromo('export-evaluation', onContinue)}>
          Trigger export-evaluation
        </button>
      </>
    )
  }

  act(() => {
    root.render(
      <McpPromoProvider>
        <Probe />
      </McpPromoProvider>,
    )
  })
}

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === label)
  expect(button).toBeTruthy()
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
