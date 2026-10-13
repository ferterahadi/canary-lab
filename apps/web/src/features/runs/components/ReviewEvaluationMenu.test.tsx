import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useEscapeToClose } from '@/shared/ui/Overlays'
import { ReviewEvaluationMenu } from './ReviewEvaluationMenu'

const mocks = vi.hoisted(() => ({ start: vi.fn(), gate: vi.fn() }))
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({ useEvaluationExports: () => ({ startExport: mocks.start }) }))
vi.mock('@/shared/shell/McpPromoContext', () => ({ useMcpPromo: () => ({ gatePromo: mocks.gate }) }))

it('dismisses its menu before its parent on Escape, and preserves outside-click and export behavior', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const parentClose = vi.fn()
  const started = vi.fn()
  const task = { taskId: 'export-fixture' }
  mocks.start.mockResolvedValue(task)
  mocks.gate.mockImplementation((_action, run) => run())
  function Parent() {
    const [open, setOpen] = useState(true)
    useEscapeToClose(() => { parentClose(); setOpen(false) }, open)
    return open ? <ReviewEvaluationMenu runId="r1" onExportStarted={started} /> : null
  }
  const escape = () => act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  const toggle = () => act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
  try {
    act(() => root.render(<Parent />))
    toggle()
    escape()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(parentClose).not.toHaveBeenCalled()
    toggle()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    toggle()
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
    expect(mocks.start).toHaveBeenCalledWith('r1', 'raw')
    expect(started).toHaveBeenCalledWith(task)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    escape()
    expect(parentClose).toHaveBeenCalledTimes(1)
  } finally { act(() => root.unmount()); container.remove() }
})
