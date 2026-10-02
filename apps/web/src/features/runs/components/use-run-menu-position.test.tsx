// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRunMenuPosition } from './use-run-menu-position'

it('right-aligns before paint, follows scroll/resize, clamps to the viewport, and releases listeners', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let right = 400
  let bottom = 50
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ right, bottom }) as DOMRect)
  function Probe({ open, width = 180 }: { open: boolean; width?: number }) {
    const anchor = useRef<HTMLButtonElement>(null)
    const pos = useRunMenuPosition(anchor, open, width)
    return <div><button ref={anchor}>Anchor</button><output>{JSON.stringify(pos)}</output></div>
  }
  const position = () => JSON.parse(container.querySelector('output')!.textContent!)
  try {
    act(() => root.render(<Probe open />))
    expect(position()).toEqual({ top: 56, left: 220 })
    bottom = 80
    right = 20
    act(() => container.firstElementChild!.dispatchEvent(new Event('scroll')))
    expect(position()).toEqual({ top: 86, left: 8 })
    right = window.innerWidth + 100
    act(() => window.dispatchEvent(new Event('resize')))
    expect(position()).toEqual({ top: 86, left: window.innerWidth - 180 - 8 })
    act(() => root.render(<Probe open width={260} />))
    expect(position().left).toBe(window.innerWidth - 260 - 8)
    act(() => root.render(<Probe open={false} />))
    expect(position()).toBeNull()
    const calls = measure.mock.calls.length
    act(() => window.dispatchEvent(new Event('resize')))
    expect(measure).toHaveBeenCalledTimes(calls)
    act(() => root.render(<Probe open />))
    act(() => root.unmount())
    const afterUnmount = measure.mock.calls.length
    window.dispatchEvent(new Event('resize'))
    expect(measure).toHaveBeenCalledTimes(afterUnmount)
  } finally {
    measure.mockRestore()
    container.remove()
  }
})
