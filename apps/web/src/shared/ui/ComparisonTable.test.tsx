// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComparisonTable } from './ComparisonTable'
import { DiffView } from './DiffView'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('comparison surfaces', () => {
  it('uses real table columns and highlights only changed text', () => {
    act(() => root.render(<ComparisonTable rows={[{ id: 'name', label: 'Name', before: 'old stable first', after: 'new stable last' }]} />))
    expect([...container.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Change', 'Before', 'After'])
    expect([...container.querySelectorAll('del')].map((part) => part.textContent)).toEqual(['old', 'first'])
    expect([...container.querySelectorAll('ins')].map((part) => part.textContent)).toEqual(['new', 'last'])
    expect(container.querySelector('[data-side="before"]')?.textContent).toBe('was old stable first')
    expect(container.querySelector('[data-side="after"]')?.textContent).toBe('now new stable last')
  })

  it('distinguishes an absent value from an empty value and escapes source text', () => {
    act(() => root.render(<ComparisonTable rows={[
      { id: 'add', before: null, after: '<script>bad()</script>' },
      { id: 'empty', before: '', after: null },
      { id: 'same', before: 'neutral', after: 'neutral' },
    ]} />))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('ins')?.textContent).toBe('<script>bad()</script>')
    expect(container.textContent).toContain('Empty value')
    expect(container.querySelector('del')?.textContent).toBe('Empty value')
    expect(container.querySelectorAll('.cl-comparison-empty')).toHaveLength(2)
    expect(container.querySelectorAll('tbody tr')[2].querySelector('ins, del')).toBeNull()
  })

  it('renders a captured patch with preserved context and a working editor action', () => {
    const open = vi.fn()
    act(() => root.render(<DiffView diff={'# Service: api\n@@ -1 +1 @@\n-app.listen(3000)\n+app.listen(process.env.PORT)'} onOpenInEditor={open} />))
    expect(container.textContent).toContain('# Service: api')
    expect(container.textContent).toContain('@@ -1 +1 @@')
    expect(container.querySelector('[data-side="before"]')?.textContent).toBe('was app.listen(3000)')
    expect(container.querySelector('[data-side="after"]')?.textContent).toBe('now app.listen(process.env.PORT)')
    act(() => container.querySelector('button')!.click())
    expect(open).toHaveBeenCalledOnce()
    act(() => root.render(<DiffView diff=" " />))
    expect(container.textContent).toBe('(no diff captured)')
  })
})
