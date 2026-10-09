// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useMouseDrag } from './use-mouse-drag'
import { mountRoot } from '@/test-helpers/mount-root'

let container: HTMLDivElement
let root: Root
let start: (origin: { x: number }) => void
function Harness({ onMove }: { onMove: (origin: { x: number }, event: MouseEvent) => void }) {
  const drag = useMouseDrag(onMove)
  start = drag.start
  return <div data-origin={drag.origin?.x ?? 'none'} />
}
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })
const move = (x: number, buttons = 1) => document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, buttons }))

it('captures the origin synchronously and uses current callbacks without resetting a drag', () => {
  const first = vi.fn()
  const latest = vi.fn()
  act(() => root.render(<Harness onMove={first} />))
  act(() => { move(50); start({ x: 100 }); move(120) })
  expect(first).toHaveBeenCalledTimes(1)
  expect(first).toHaveBeenCalledWith({ x: 100 }, expect.objectContaining({ clientX: 120 }))
  act(() => root.render(<Harness onMove={latest} />))
  act(() => move(160))
  expect(latest).toHaveBeenCalledWith({ x: 100 }, expect.objectContaining({ clientX: 160 }))
  expect(container.firstElementChild?.getAttribute('data-origin')).toBe('100')
  act(() => { document.dispatchEvent(new MouseEvent('mouseup')); move(200) })
  expect(latest).toHaveBeenCalledTimes(1)
  expect(container.firstElementChild?.getAttribute('data-origin')).toBe('none')
})

it('releases missed mouseup without applying a stray movement and accepts a new drag', () => {
  const onMove = vi.fn()
  act(() => root.render(<Harness onMove={onMove} />))
  act(() => { start({ x: 100 }); move(200, 0); move(300) })
  expect(onMove).not.toHaveBeenCalled()
  expect(container.firstElementChild?.getAttribute('data-origin')).toBe('none')
  act(() => { start({ x: 400 }); move(450) })
  expect(onMove).toHaveBeenCalledWith({ x: 400 }, expect.objectContaining({ clientX: 450 }))
})

it('handles a same-frame click release and removes listeners during an active drag', () => {
  const onMove = vi.fn()
  act(() => root.render(<Harness onMove={onMove} />))
  act(() => { start({ x: 100 }); document.dispatchEvent(new MouseEvent('mouseup')); move(120) })
  expect(onMove).not.toHaveBeenCalled()
  expect(container.firstElementChild?.getAttribute('data-origin')).toBe('none')
  act(() => { start({ x: 200 }) })
  act(() => root.render(null))
  act(() => { move(250); document.dispatchEvent(new MouseEvent('mouseup')) })
  expect(onMove).not.toHaveBeenCalled()
})
