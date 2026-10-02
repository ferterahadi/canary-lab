// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as configApi from '@/shared/api/config'
import { StageChoiceGrid } from './ModelPlanEditor'

vi.mock('@/shared/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/config')>()),
  getAgentProbe: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('StageChoiceGrid', () => {
  it('renders only the scoped stages and reports changes through onChange', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<StageChoiceGrid agent="codex" stages={['heal', 'commit']} draft={{}} onChange={onChange} />)
    })
    expect(document.querySelector('[data-testid="model-row-heal"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="model-row-scout"]')).toBeNull()
    // Without a discovered catalog, Codex falls back to default + custom.
    const modelSelect = document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair model"]')!
    expect([...modelSelect.options].map((o) => o.value)).toEqual(['', '__custom'])
    setSelect(document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair reasoning effort"]')!, 'xhigh')
    expect(onChange).toHaveBeenCalledWith('heal', { model: null, effort: 'xhigh' })
    expect(configApi.getAgentProbe).not.toHaveBeenCalled()
  })

  it("a deviating row's reset names the recommendation it restores on hover", async () => {
    await act(async () => {
      root.render(
        <StageChoiceGrid agent="claude" stages={['heal']} draft={{ heal: { model: 'haiku', effort: 'low' } }} onChange={vi.fn()} />,
      )
    })
    const reset = document.querySelector<HTMLButtonElement>('[data-mark="custom"]')!
    await act(async () => { reset.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(/^Differs from recommended \(.+\)\. Reset$/)
  })
})
