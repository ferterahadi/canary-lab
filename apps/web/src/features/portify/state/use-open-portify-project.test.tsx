import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { openPortifyProject } from '@/shared/api/cleanup'
import { useOpenPortifyProject } from './use-open-portify-project'

vi.mock('@/shared/api/cleanup', () => ({ openPortifyProject: vi.fn() }))
const container = document.createElement('div')
let root = createRoot(container)
let hook: ReturnType<typeof useOpenPortifyProject>
function Probe({ id }: { id: string }) {
  hook = useOpenPortifyProject(id)
  return <span>{hook.openError}</span>
}
afterEach(() => { act(() => root.unmount()); root = createRoot(container); vi.resetAllMocks() })

it.each([
  ['reported', { opened: false, paths: [], error: 'no editor' }, 'no editor'],
  ['fallback', { opened: false, paths: [] }, 'Failed to open editor'],
  ['exception', new Error('offline'), 'offline'],
  ['non-error', 'offline', 'Failed to open editor'],
] as const)('reports %s failures, clears on retry, and uses the current workflow', async (_kind, result, message) => {
  await act(async () => root.render(<Probe id="first" />))
  if (typeof result === 'object' && !(result instanceof Error)) vi.mocked(openPortifyProject).mockResolvedValueOnce({ ...result, paths: [...result.paths] })
  else vi.mocked(openPortifyProject).mockRejectedValueOnce(result)
  await act(async () => hook.openProject())
  expect(container.textContent).toBe(message)
  expect(openPortifyProject).toHaveBeenLastCalledWith('first')
  await act(async () => root.render(<Probe id="second" />))
  let finish!: (value: { opened: boolean; paths: string[] }) => void
  vi.mocked(openPortifyProject).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  let pending!: Promise<void>
  act(() => { pending = hook.openProject() })
  expect(container.textContent).toBe('')
  expect(openPortifyProject).toHaveBeenLastCalledWith('second')
  await act(async () => { finish({ opened: true, paths: ['/overlay'] }); await pending })
  expect(container.textContent).toBe('')
})
