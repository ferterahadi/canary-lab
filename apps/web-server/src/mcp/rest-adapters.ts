import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import type { CanaryLabMcpDeps, GettingStartedBusyActive } from './tool-schemas'
import type { GettingStartedRunWorkflow } from '../features/config/routes/onboarding'
import type { RepoUpdateRefusal } from '../features/runs/logic/runtime/repo-upstream-update'
import { MCP_ORIGIN_HEADER } from '../features/flights/routes/flight-decision-origin'

type McpRestAdapters = Required<Pick<CanaryLabMcpDeps,
  | 'coverageRequest' | 'testReviewRequest' | 'discoveryRepairRequest' | 'flightsRequest'
  | 'startRun' | 'startVerification' | 'writeEnvsetSlot' | 'handoffHeal'
>>

interface McpRestAdapterDeps {
  inject: (request: InjectOptions) => Promise<Pick<LightMyRequestResponse, 'statusCode' | 'payload' | 'json'>>
  gettingStartedRunWorkflow: (feature: string) => GettingStartedRunWorkflow | null
  isGettingStartedFlightStart: (payload: Record<string, unknown> | undefined) => boolean
}

/** Reuse route-owned validation and execution while preserving MCP response contracts. */
export function createMcpRestAdapters({
  inject, gettingStartedRunWorkflow, isGettingStartedFlightStart,
}: McpRestAdapterDeps): McpRestAdapters {
  return {
    coverageRequest: async (request) => {
      const response = await inject(request)
      return { statusCode: response.statusCode, body: response.json() }
    },
    testReviewRequest: async (request) => {
      const response = await inject({ method: request.method, url: request.url, payload: request.payload as Record<string, unknown> | undefined, headers: { [MCP_ORIGIN_HEADER]: 'mcp' } })
      return { statusCode: response.statusCode, body: response.json() }
    },
    discoveryRepairRequest: async (request) => {
      const response = await inject({ method: request.method, url: request.url, payload: request.payload as Record<string, unknown> | undefined })
      return { statusCode: response.statusCode, body: response.json() }
    },
    // Flight over MCP: reuse the flights REST routes so the MCP surface
    // shares the store + conductor (and single-flight guard) with the UI/CLI.
    flightsRequest: async (o) => {
      const originalPayload = o.payload as Record<string, unknown> | undefined
      const isGettingStartedFlight = o.method === 'POST'
        && o.url === '/api/flights'
        && isGettingStartedFlightStart(originalPayload)
      const payload = isGettingStartedFlight
        ? { ...originalPayload, gettingStartedSource: 'external' }
        : originalPayload
      const resp = await inject({
        method: o.method,
        url: o.url,
        // Marks this as the MCP client acting, not the browser. An externally
        // driven flight hands every decision to that client, so the lifecycle
        // routes refuse the same calls when they arrive from the web UI — and
        // MCP and the UI post to the identical endpoints, so without this the
        // guard could not tell them apart. See requireFlightDecisionOrigin.
        headers: { [MCP_ORIGIN_HEADER]: 'mcp' },
        ...(payload !== undefined ? { payload } : {}),
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })() as unknown
      return { statusCode: resp.statusCode, body }
    },
    startRun: async (feature, env, healAgent, isolation, executionType, updateRepos) => {
      const demoWorkflow = executionType === 'boot' ? null : gettingStartedRunWorkflow(feature)
      const resp = await inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          feature,
          env,
          ...(healAgent ? { healAgent } : {}),
          ...(isolation ? { isolation } : {}),
          ...(executionType === 'boot' ? { mode: 'boot' } : {}),
          ...(updateRepos !== undefined ? { updateRepos } : {}),
          ...(demoWorkflow
            ? { gettingStartedSource: 'external', gettingStartedWorkflow: demoWorkflow }
            : {}),
        },
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })() as Record<string, unknown>
      if (resp.statusCode === 201 || resp.statusCode === 200) {
        return { kind: 'started', runId: String(body.runId) }
      }
      if (resp.statusCode === 202) {
        return { kind: 'queued', runId: String(body.runId), reason: body.queueReason === 'repo-collision' ? 'repo-collision' : 'resources' }
      }
      if (resp.statusCode === 409 && body.type === 'repo_collision_requires_choice') {
        return {
          kind: 'collision',
          conflictingRunId: String(body.conflictingRunId),
          conflictingFeature: String(body.conflictingFeature),
          repoPaths: Array.isArray(body.repoPaths) ? body.repoPaths as string[] : [],
          options: ['worktree', 'queue'],
          message: String(body.message ?? 'Same-app collision.'),
        }
      }
      if (resp.statusCode === 409 && body.type === 'repo_update_refused') {
        return {
          kind: 'repo-update-refused',
          repos: Array.isArray(body.repos) ? body.repos as RepoUpdateRefusal[] : [],
          message: String(body.error ?? 'Repo upstream update refused.'),
        }
      }
      if (resp.statusCode === 409 && body.type === 'getting_started_busy') {
        return {
          kind: 'getting-started-busy',
          active: body.active as GettingStartedBusyActive,
          message: String(body.error ?? 'Another Getting Started demo is already running.'),
        }
      }
      const message = body && 'error' in body ? String(body.error) : String(resp.payload)
      if (body.type === 'test_review_required') throw Object.assign(new Error(message), { testReviewRequired: body })
      throw new Error(`start_run failed (${resp.statusCode}): ${message}`)
    },
    startVerification: async (feature, input) => {
      const resp = await inject({
        method: 'POST',
        url: `/api/features/${encodeURIComponent(feature)}/verifications`,
        payload: input,
      })
      if (resp.statusCode !== 200 && resp.statusCode !== 201) {
        const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
        const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : String(body)
        throw new Error(`execute_verification failed (${resp.statusCode}): ${message}`)
      }
      return JSON.parse(resp.payload) as { runId: string }
    },
    writeEnvsetSlot: async (feature, env, slot, entries) => {
      const resp = await inject({
        method: 'PUT',
        url: `/api/features/${encodeURIComponent(feature)}/envsets/${encodeURIComponent(env)}/${encodeURIComponent(slot)}`,
        payload: { entries },
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
      if (resp.statusCode !== 200 && resp.statusCode !== 201) {
        const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : String(body)
        throw new Error(`write_envset failed (${resp.statusCode}): ${message}`)
      }
      return body as { path: string; entries: Array<{ key: string; value: string }>; unparsedLines: number[] }
    },
    handoffHeal: async (runId, to, sessionId, guidance) => {
      const resp = await inject({
        method: 'POST',
        url: `/api/runs/${encodeURIComponent(runId)}/heal-agent/handoff`,
        payload: {
          to,
          ...(sessionId ? { sessionId } : {}),
          ...(guidance ? { guidance } : {}),
        },
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
      return { statusCode: resp.statusCode, body }
    },
  }
}
