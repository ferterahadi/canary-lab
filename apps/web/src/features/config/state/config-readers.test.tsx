import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConfigValue } from '@shared/config-value'
import type { ParsedConfigDoc } from '@/shared/api/config'
import { useImmediateConfig } from './use-immediate-config'
import { useRepoPathProbe } from './use-repo-path-probe'

const api = vi.hoisted(() => ({ getFeatureConfigDoc: vi.fn(), getPlaywrightConfig: vi.fn(), putFeatureConfigDoc: vi.fn(), putPlaywrightConfig: vi.fn(), checkPathExists: vi.fn(), getGitRemote: vi.fn() }))
vi.mock('@/shared/api/config', async (original) => ({ ...(await original<typeof import('@/shared/api/config')>()), ...api }))
vi.mock('@/shared/api/workspace', async (original) => ({ ...(await original<typeof import('@/shared/api/workspace')>()), checkPathExists: api.checkPathExists, getGitRemote: api.getGitRemote }))
let root: Root
let config: ReturnType<typeof useImmediateConfig>
let probe: ReturnType<typeof useRepoPathProbe>
const doc = (value: ConfigValue): ParsedConfigDoc => ({ path: '/workspace/playwright.config.ts', format: 'ts', content: '', parsed: { value, source: '', complexFields: [] } })
function Config({ revision = 1 }: { revision?: number }) { config = useImmediateConfig('playwright-test', 'playwright', revision); return null }
function PathProbe({ value, remote }: { value: string; remote: string | null }) { probe = useRepoPathProbe(value, remote); return null }
beforeEach(() => {
  root = createRoot(document.createElement('div'))
  vi.clearAllMocks()
  api.getPlaywrightConfig.mockResolvedValue(doc({ workers: 1 }))
  api.putPlaywrightConfig.mockImplementation(async (_feature, value) => doc(value))
  api.checkPathExists.mockResolvedValue({ exists: true })
  api.getGitRemote.mockResolvedValue({ remote: 'https://example.test/repo.git' })
})
afterEach(() => act(() => root.unmount()))

it('saves Playwright field changes and reloads when its parent revision changes', async () => {
  await act(async () => root.render(<Config />))
  await act(async () => config.update((value) => { if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(value, { workers: 2 }) }))
  expect(api.putPlaywrightConfig).toHaveBeenCalledWith('playwright-test', { workers: 2 })
  expect(config.value).toEqual({ workers: 2 })
  const reads = api.getPlaywrightConfig.mock.calls.length
  api.getPlaywrightConfig.mockResolvedValue(doc({ workers: 3 }))
  await act(async () => root.render(<Config revision={2} />))
  expect(api.getPlaywrightConfig.mock.calls.length).toBeGreaterThan(reads)
  expect(config.value).toEqual({ workers: 3 })
})

it('makes empty path probes lazy and requests a remote only for the selected path', async () => {
  await act(async () => root.render(<PathProbe value="" remote={null} />))
  expect(api.checkPathExists).not.toHaveBeenCalled()
  expect(api.getGitRemote).not.toHaveBeenCalled()
  await act(async () => root.render(<PathProbe value="/workspace/repo" remote="/workspace/repo" />))
  expect(api.checkPathExists).toHaveBeenCalledWith('/workspace/repo')
  expect(api.getGitRemote).toHaveBeenCalledWith('/workspace/repo')
  expect(probe.existence.value).toEqual({ exists: true })
  await act(async () => root.render(<PathProbe value="/workspace/other" remote="/workspace/repo" />))
  expect(api.getGitRemote).toHaveBeenCalledTimes(1)
  expect(probe.remote.value).toBeNull()
})
