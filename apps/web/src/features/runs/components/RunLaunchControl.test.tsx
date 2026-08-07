// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunLaunchControl } from './RunLaunchControl'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

function renderControl(props: Partial<Parameters<typeof RunLaunchControl>[0]> = {}): HTMLButtonElement {
  act(() => {
    root.render(
      <RunLaunchControl
        feature="storefront_journey"
        envs={['local']}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
        runDisabled={false}
        onStartEnv={() => {}}
        onVerify={() => {}}
        {...props}
      />,
    )
  })
  const button = container.querySelector<HTMLButtonElement>('button[data-run-launch-menu]')
  if (!button) throw new Error('no launch button')
  return button
}

describe('RunLaunchControl first-run cue', () => {
  it('carries no cue by default', () => {
    const button = renderControl()
    expect(button.className).not.toContain('cl-cue-ring')
    expect(button.dataset.cued).toBeUndefined()
  })

  // The ring is a static outline, not an opacity animation: the headless preview
  // forces reduced-motion, and a fading primary button reads as disabled.
  it('rings the button when the guide points at it', () => {
    const button = renderControl({ cued: true })
    expect(button.className).toContain('cl-cue-ring')
    expect(button.dataset.cued).toBe('true')
  })

  it('keeps the cue off the compact variant\'s other classes', () => {
    const button = renderControl({ cued: true, compact: true })
    expect(button.className).toContain('cl-run-menu-button-compact')
    expect(button.className).toContain('cl-cue-ring')
  })
})
