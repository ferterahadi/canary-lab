import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { ConfigDocCacheProvider } from './config-doc-cache'
import { EnvsetsTab } from './EnvsetsTab'

vi.mock('@/shared/api/client', () => ({ getEnvsetsIndex: vi.fn() }))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.resetAllMocks() })

it('characterizes the existing open-dialog limitation: parent refresh does not reload its envset index', async () => {
  const read = vi.mocked(api.getEnvsetsIndex)
  read.mockResolvedValue({ envs: [{ name: 'local', slots: [] }], slotDescriptions: {}, slotTargets: {} })
  const render = () => root.render(<ConfigDocCacheProvider><EnvsetsTab feature="checkout" /></ConfigDocCacheProvider>)
  await act(async () => { render() })
  expect(container.querySelector('option[value="local"]')).not.toBeNull()
  read.mockResolvedValue({ envs: [{ name: 'local', slots: [] }, { name: 'staging', slots: [] }], slotDescriptions: {}, slotTargets: {} })
  // Workspace envsets-changed currently refreshes the parent feature list only.
  // The same mounted dialog retains its cached index. This is not live proof.
  await act(async () => { render() })
  expect(read).toHaveBeenCalledTimes(1)
  expect(container.querySelector('option[value="staging"]')).toBeNull()
  await act(async () => { root.render(null) })
  await act(async () => { render() })
  expect(read).toHaveBeenCalledTimes(2)
  expect(container.querySelector('option[value="staging"]')).not.toBeNull()
})
