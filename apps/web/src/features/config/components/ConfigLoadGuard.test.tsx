// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ConfigLoadGuard } from './ConfigLoadGuard'
import { mountRoot } from '@/test-helpers/mount-root'

let container: HTMLDivElement
let root: Root

mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

function rendered(error?: string): HTMLElement {
  act(() => root.render(<ConfigLoadGuard error={error} />))
  return container.firstElementChild as HTMLElement
}

it('says Loading… in the muted hue while the document is still being read', () => {
  const guard = rendered()
  expect(guard.textContent).toBe('Loading…')
  expect(guard.style.color).toBe('var(--text-muted)')
})

it('shows a failed read in the danger hue, on every tab alike', () => {
  const guard = rendered('config read failed')
  expect(guard.textContent).toBe('config read failed')
  expect(guard.style.color).toBe('var(--danger)')
})
