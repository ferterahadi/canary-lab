// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import * as api from '../../../shared/api/client'
import { RestartHealButton } from './RestartHealButton'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
	  return {
	    ...actual,
	    restartRun: vi.fn(),
	  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
	  vi.mocked(api.restartRun).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('RestartHealButton', () => {
	  it('renders the Retest Remaining button with the shared action styling', () => {
	    const html = renderToStaticMarkup(<RestartHealButton runId="r1" />)
	    expect(html).toContain('Retest Remaining')
	    expect(html).toContain('Reruns failed, skipped, and pending tests.')
	    expect(html).toContain('rounded-md px-3 py-1.5 text-xs')
	    expect(html).not.toContain('Type guidance for the agent in the pane after it spawns')
    // No stray input field — the REPL owns input once the new orchestrator
    // spawns, so the button is the only control here.
    expect(html).not.toContain('<input')
  })

  it('notifies the parent after the restart request succeeds', async () => {
	    vi.mocked(api.restartRun).mockResolvedValue({ status: 'restarted', mode: 'remaining' })
    const onRestarted = vi.fn()

    await act(async () => {
      root.render(<RestartHealButton runId="r1" onRestarted={onRestarted} />)
    })
    const button = container.querySelector('button')
    expect(button).toBeTruthy()

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

	    expect(api.restartRun).toHaveBeenCalledWith('r1')
	    expect(onRestarted).toHaveBeenCalledTimes(1)
	  })
})
