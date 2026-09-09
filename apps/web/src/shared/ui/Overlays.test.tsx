// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Modal } from './Overlays'

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
