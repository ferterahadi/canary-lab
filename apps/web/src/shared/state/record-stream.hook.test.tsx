import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRecordStream } from './record-stream'
import { createObservedReads } from './observed-reads'

it.each([false, true])('handles an unavailable socket with fallback set to %s', async (allowUnavailableSocket) => {
  vi.stubGlobal('WebSocket', undefined)
  const errors = vi.fn()
  const container = document.createElement('div')
  const root = createRoot(container, { onUncaughtError: errors })
  const reads = createObservedReads()
  function Consumer() {
    useRecordStream({ url: 'ws://synthetic/records', reads, allowUnavailableSocket,
      decode: () => null, recordId: () => null, dispatch: () => {}, onConnection: () => {},
    })
    return <span>REST fallback</span>
  }
  try {
    if (allowUnavailableSocket) await act(async () => root.render(<Consumer />))
    else await expect(act(async () => root.render(<Consumer />))).rejects.toThrow('WebSocket implementation not available')
    expect(container.textContent).toBe(allowUnavailableSocket ? 'REST fallback' : '')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
