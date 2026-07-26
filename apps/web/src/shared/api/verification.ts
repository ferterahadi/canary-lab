// Deployed-environment verification: targets, configs, execution.
// Split out of client.ts; see that barrel for the shared surface.

import type { VerificationConfig, VerificationTarget } from './types'
import { defaultOpts, request, type ClientOptions } from './internal'

export interface VerificationTargetIndex {
  targets: VerificationTarget[]
  targetUrls: Record<string, string>
}

export function getVerificationTargets(
  feature: string,
  envset?: string,
  opts?: ClientOptions,
): Promise<VerificationTargetIndex> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = envset ? `?envset=${encodeURIComponent(envset)}` : ''
  return request<VerificationTargetIndex>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-targets${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listVerificationConfigs(
  feature: string,
  opts?: ClientOptions,
): Promise<VerificationConfig[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig[]>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function createVerificationConfig(
  feature: string,
  body: { name: string; targetUrls: Record<string, string>; playwrightEnvsetId: string },
  opts?: ClientOptions,
): Promise<VerificationConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function updateVerificationConfig(
  feature: string,
  configId: string,
  body: { name: string; targetUrls: Record<string, string>; playwrightEnvsetId: string },
  opts?: ClientOptions,
): Promise<VerificationConfig> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<VerificationConfig>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verification-configs/${encodeURIComponent(configId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function executeVerification(
  feature: string,
  body: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  opts?: ClientOptions,
): Promise<{ runId: string; executionType: 'verify' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ runId: string; executionType: 'verify' }>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/verifications`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}
