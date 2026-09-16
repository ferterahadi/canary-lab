// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Modal, useDismissOnOutsideMousedown } from './Overlays'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function Harness() {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  return <>
    <button id="launcher" onClick={() => setOpen(true)}>Open</button>
    <Modal open={open} portal onClose={() => setOpen(false)} title="Inspector">
      <button id="nested-launcher" onClick={() => setConfirm(true)}>Confirm</button>
    </Modal>
    <Modal open={confirm} portal onClose={() => setConfirm(false)} title="Confirmation"><button>Keep running</button></Modal>
  </>
}

it('contains focus, closes only the top Escape layer, and restores the opener and body scroll', () => {
  document.body.style.overflow = 'auto'
  act(() => root.render(<Harness />))
  const launch = document.querySelector<HTMLButtonElement>('#launcher')!
  launch.focus()
  act(() => launch.click())
  const inspector = document.querySelector<HTMLElement>('[aria-label="Inspector"]')!
  expect(document.activeElement).toBe(inspector)
  expect(document.body.style.overflow).toBe('hidden')
  const confirm = document.querySelector<HTMLButtonElement>('#nested-launcher')!
  confirm.focus()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(inspector.querySelector('[aria-label="Close"]'))
  confirm.focus()
  act(() => confirm.click())
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Confirmation"]'))
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[aria-label="Confirmation"]')).toBeNull()
  expect(document.querySelector('[aria-label="Inspector"]')).not.toBeNull()
  expect(document.activeElement).toBe(confirm)
  launch.focus()
  expect(document.activeElement).toBe(inspector)
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[aria-label="Inspector"]')).toBeNull()
  expect(document.activeElement).toBe(launch)
  expect(document.body.style.overflow).toBe('auto')
})

it('does not treat a click inside a modal as a backdrop click', () => {
  const close = vi.fn()
  act(() => root.render(<Modal open onClose={close} title="Inspector"><p>Body</p></Modal>))
  act(() => container.querySelector<HTMLElement>('[role="dialog"] p')!.click())
  expect(close).not.toHaveBeenCalled()
  act(() => container.querySelector<HTMLElement>('.cl-modal-backdrop')!.click())
  expect(close).toHaveBeenCalledTimes(1)
})

// A portalled menu is not a DOM descendant of the button that opened it, so a
// single-ref containment check would dismiss the menu on its own first click.
it('ignores mousedown inside any owned element — trigger or portalled surface — and stops listening when disabled', () => {
  const dismiss = vi.fn()
  function Dropdown({ open }: { open: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null)
    const menu = useRef<HTMLDivElement>(null)
    useDismissOnOutsideMousedown(dismiss, open, [trigger, menu])
    return <>
      <button id="trigger" ref={trigger}>Menu</button>
      {open && createPortal(<div id="menu" ref={menu}><button id="item">Item</button></div>, document.body)}
    </>
  }
  const outside = document.createElement('button')
  document.body.append(outside)
  act(() => root.render(<Dropdown open />))
  const down = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  down(document.querySelector('#trigger')!)
  down(document.querySelector('#item')!)
  expect(dismiss).not.toHaveBeenCalled()
  down(outside)
  expect(dismiss).toHaveBeenCalledTimes(1)
  act(() => root.render(<Dropdown open={false} />))
  down(outside)
  expect(dismiss).toHaveBeenCalledTimes(1)
  outside.remove()
})
