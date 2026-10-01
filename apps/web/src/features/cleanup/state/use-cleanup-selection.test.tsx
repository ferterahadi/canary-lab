// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useCleanupSelection } from './use-cleanup-selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('lets a user deselect eligible rows and refuses stale callbacks for protected rows', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  let selection!: ReturnType<typeof useCleanupSelection<{ id: string; active: boolean }>>
  function Harness() {
    selection = useCleanupSelection([{ id: 'done', active: false }, { id: 'running', active: true }], (row) => row.id, (row) => !row.active, true)
    return null
  }
  try {
    act(() => root.render(<Harness />))
    act(() => selection.toggle('done'))
    expect([...selection.selected]).toEqual(['done'])
    act(() => selection.toggle('done'))
    expect([...selection.selected]).toEqual([])
    act(() => selection.toggle('running'))
    act(() => selection.toggle('missing'))
    expect([...selection.selected]).toEqual([])
  } finally {
    act(() => root.unmount())
  }
})
