// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import * as api from '../api/client'
import { RestartHealButton } from './RestartHealButton'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    sendAgentInput: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.sendAgentInput).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('RestartHealButton', () => {
  it('renders the Restart Heal button without stale guidance text', () => {
    const html = renderToStaticMarkup(<RestartHealButton runId="r1" />)
    expect(html).toContain('Restart Heal')
    expect(html).not.toContain('Type guidance for the agent in the pane after it spawns')
    // No stray input field — the REPL owns input once the new orchestrator
    // spawns, so the button is the only control here.
    expect(html).not.toContain('<input')
  })

  it('notifies the parent after the restart request succeeds', async () => {
    vi.mocked(api.sendAgentInput).mockResolvedValue({ status: 'restarted' })
    const onRestarted = vi.fn()

    await act(async () => {
      root.render(<RestartHealButton runId="r1" onRestarted={onRestarted} />)
    })
    const button = container.querySelector('button')
    expect(button).toBeTruthy()

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.sendAgentInput).toHaveBeenCalledWith('r1', '')
    expect(onRestarted).toHaveBeenCalledTimes(1)
  })
})
