import { describe, it, expect, vi } from 'vitest'
import {
  getVerificationTargets,
  listVerificationConfigs,
  createVerificationConfig,
  updateVerificationConfig,
  executeVerification,
} from './verification'
import { ok } from './__fixtures__/response'

describe('verification api', () => {
  it('uses verification target and config endpoints with encoded feature names', async () => {
    const targetIndex = {
      targets: [{ id: 'api', name: 'API', envVar: 'GATEWAY_URL' }],
      targetUrls: { api: 'https://api.example.com' },
    }
    const config = {
      id: 'config/1',
      featureId: 'checkout',
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z',
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(targetIndex))
      .mockResolvedValueOnce(ok(targetIndex))
      .mockResolvedValueOnce(ok([config]))
      .mockResolvedValueOnce(ok(config, 201))
      .mockResolvedValueOnce(ok({ ...config, name: 'Beta' }))

    await expect(getVerificationTargets('feat/a', 'production', { fetchImpl })).resolves.toEqual(targetIndex)
    await expect(getVerificationTargets('feat/a', undefined, { fetchImpl })).resolves.toEqual(targetIndex)
    await expect(listVerificationConfigs('feat/a', { fetchImpl })).resolves.toEqual([config])
    await expect(createVerificationConfig('feat/a', {
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
    }, { fetchImpl })).resolves.toEqual(config)
    await expect(updateVerificationConfig('feat/a', 'config/1', {
      name: 'Beta',
      targetUrls: { api: 'https://beta.example.com' },
      playwrightEnvsetId: 'production',
    }, { fetchImpl })).resolves.toMatchObject({ name: 'Beta' })

    expect(fetchImpl.mock.calls[0]).toEqual([
      '/api/features/feat%2Fa/verification-targets?envset=production',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[1]).toEqual([
      '/api/features/feat%2Fa/verification-targets',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[2]).toEqual([
      '/api/features/feat%2Fa/verification-configs',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[3][0]).toBe('/api/features/feat%2Fa/verification-configs')
    expect(fetchImpl.mock.calls[3][1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse((fetchImpl.mock.calls[3][1] as RequestInit).body as string)).toEqual({
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
    })
    expect(fetchImpl.mock.calls[4][0]).toBe('/api/features/feat%2Fa/verification-configs/config%2F1')
    expect(fetchImpl.mock.calls[4][1]).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' } })
  })

  it('executes deployment verification with optional config and target overrides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'verify-1', executionType: 'verify' }, 201))

    await expect(executeVerification('feat/a', {
      configId: 'config/1',
      playwrightEnvsetId: 'production',
      targetUrls: { api: 'https://api.example.com' },
      bootRunId: 'boot-1',
    }, { fetchImpl })).resolves.toEqual({ runId: 'verify-1', executionType: 'verify' })

    expect(fetchImpl).toHaveBeenCalledWith('/api/features/feat%2Fa/verifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configId: 'config/1',
        playwrightEnvsetId: 'production',
        targetUrls: { api: 'https://api.example.com' },
        bootRunId: 'boot-1',
      }),
    })
  })
})
