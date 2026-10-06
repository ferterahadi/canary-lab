// Deployed-environment verification: targets, configs, execution.
// Split out of client.ts; see that barrel for the shared surface.

import type { VerificationConfig, VerificationTarget } from '@shared/verification'
import { requestJson, defaultOpts, request, type ClientOptions } from './internal'

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
  return requestJson<VerificationConfig>(`/api/features/${encodeURIComponent(feature)}/verification-configs`, 'POST', body, opts)
}

export function updateVerificationConfig(
  feature: string,
  configId: string,
  body: { name: string; targetUrls: Record<string, string>; playwrightEnvsetId: string },
  opts?: ClientOptions,
): Promise<VerificationConfig> {
  return requestJson<VerificationConfig>(`/api/features/${encodeURIComponent(feature)}/verification-configs/${encodeURIComponent(configId)}`, 'PUT', body, opts)
}

export function executeVerification(
  feature: string,
  body: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string; bootRunId?: string; gettingStartedSource?: 'internal' | 'external' },
  opts?: ClientOptions,
): Promise<{ runId: string; executionType: 'verify' }> {
  return requestJson<{ runId: string; executionType: 'verify' }>(`/api/features/${encodeURIComponent(feature)}/verifications`, 'POST', body, opts)
}
