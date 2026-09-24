// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CopyFromModal } from './CopyFromModal'

vi.mock('@/shared/api/client', () => ({
  getEnvsetSlot: vi.fn(async () => ({ entries: [{ key: 'PORT', value: '4000' }, { key: 'NEW', value: '' }] })),
}))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('shows the actual selected result and applies exactly that result', async () => {
  const apply = vi.fn()
  await act(async () => root.render(<CopyFromModal feature="shop" targetEnv="local" slot="api" siblingEnvs={['staging']} current={[{ key: 'PORT', value: '3000' }, { key: 'EXTRA', value: 'keep' }]} onClose={vi.fn()} onApply={apply} />))
  const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!
  await act(async () => button('Compare').click())
  const row = (key: string) => [...document.querySelectorAll('tbody tr')].find((node) => node.querySelector('label')?.textContent === key)!
  const after = (key: string) => row(key).querySelector('[data-side="after"]')?.textContent
  expect(after('PORT')).toBe('now 4000')
  expect(after('NEW')).toBe('now Empty value')
  expect(after('EXTRA')).toBe('now keep')
  expect(row('EXTRA').querySelector('del, ins')).toBeNull()
  act(() => row('PORT').querySelector('input')!.click())
  expect(after('PORT')).toBe('now 3000')
  expect(row('PORT').querySelector('del, ins')).toBeNull()
  act(() => row('NEW').querySelector('input')!.click())
  expect(after('NEW')).toBe('Not present')
  act(() => row('EXTRA').querySelector('input')!.click())
  expect(after('EXTRA')).toBe('Not present')
  expect(row('EXTRA').querySelector('del')?.textContent).toBe('keep')
  act(() => button('Apply').click())
  expect(apply).toHaveBeenCalledWith([{ key: 'PORT', value: '3000' }])
})
