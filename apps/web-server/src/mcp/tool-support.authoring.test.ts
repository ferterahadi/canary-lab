import { describe, expect, it, vi } from 'vitest'
import type { DraftRecord, ExternalDraftStage } from '../features/wizard/logic/draft-store'
import { isTransientGenerationStatus } from '../features/wizard/routes/tests-draft-support'
import type { CanaryLabMcpDeps } from './tool-schemas'
import {
  authoringCtx,
  coverageBlockedNext,
  externalDraftAuthoringNextSteps,
  externalDraftView,
  newDraftId,
  statusForExternalStage,
} from './tool-support'

// The helpers the authoring tool groups (authoring-features, authoring-env,
// authoring-drafts) share. Two different kinds of contract live here and both
// are load-bearing:
//
//   - `authoringCtx` decides whether a write announces itself to the UI at all.
//   - the rest produce PROSE and STATUS an agent acts on. A draft's status gates
//     the cancel-generation control, and `coverageBlockedNext` is the only thing
//     standing between a blocked ledger and an agent inventing a PRD to unblock
//     it — so these are asserted on what they instruct, not on their wording.

describe('authoringCtx', () => {
  it('carries the workspace bus through so a tool write announces itself', () => {
    // The shared writers publish their own events (FeatureAuthoringContext). A
    // context assembled without `workspaceEvents` still writes — silently — so
    // the Docs rail and coverage tabs would go stale until a manual refresh.
    const workspaceEvents = { publish: vi.fn() }
    const deps = {
      projectRoot: '/ws',
      featuresDir: '/ws/features',
      workspaceEvents,
      store: { logsDir: '/ws/logs' },
      broker: {},
    } as unknown as CanaryLabMcpDeps

    const ctx = authoringCtx(deps)

    expect(ctx.workspaceEvents).toBe(workspaceEvents)
    // Exactly these three keys: the writers take a narrow context on purpose, so
    // handing them the whole deps bag would let a writer reach the run store.
    expect(ctx).toEqual({ projectRoot: '/ws', featuresDir: '/ws/features', workspaceEvents })
  })

  it('passes on a missing bus rather than inventing one', () => {
    // A caller with no bus (a unit test, or a CLI-side write) still writes.
    const ctx = authoringCtx({ projectRoot: '/ws', featuresDir: '/ws/features' } as unknown as CanaryLabMcpDeps)

    expect(ctx.workspaceEvents).toBeUndefined()
  })
})

describe('coverageBlockedNext', () => {
  it('tells the agent to wait rather than start a second job while one is generating', () => {
    const next = coverageBlockedNext('checkout', 'generating', 0)

    expect(next).toContain('single-flight')
    expect(next).toContain('get_feature_coverage("checkout")')
    // Even with no source doc on file, a running job must not divert the agent
    // into asking the user for a PRD — the job in flight is already building one.
    expect(next).not.toMatch(/ASK THE USER/)
  })

  it('routes a stale summary through a refresh before remapping', () => {
    const next = coverageBlockedNext('checkout', 'stale', 3)

    expect(next).toContain('start_external_summary with feature "checkout" and a stable session_id')
    expect(next).toContain('start_external_coverage with the same session_id')
    expect(next).toContain('submit_external_coverage')
    expect(next).not.toMatch(/ASK THE USER/)
  })

  it('asks the USER for the PRD when nothing grounds the coverage, and forbids substituting one', () => {
    // The one case that needs a human. Grounded coverage has to come from a real
    // PRD/spec; an agent that invents one produces a ledger that measures nothing,
    // which is the exact failure the coverage axis exists to prevent.
    const next = coverageBlockedNext('checkout', 'absent', 0)

    expect(next).toMatch(/ASK THE USER/)
    expect(next).toContain('do NOT invent one or pull an external file')
    expect(next).toContain('write_feature_doc("checkout"')
    expect(next).toContain('a stable session_id')
  })

  it('has the agent author the summary itself once source docs exist', () => {
    const next = coverageBlockedNext('checkout', 'absent', 2)

    expect(next).toContain('YOU author it')
    expect(next).toContain('start_external_summary with feature "checkout" and a stable session_id')
    // No human step here: the material to ground the summary is already on file.
    expect(next).not.toMatch(/ASK THE USER/)
  })
})

describe('statusForExternalStage', () => {
  it('settles the record only on the two terminal stages', () => {
    expect(statusForExternalStage('ready')).toBe('spec-ready')
    expect(statusForExternalStage('applied')).toBe('accepted')
    expect(statusForExternalStage('error')).toBe('error')
  })

  it('reports every stage before ready as generating, which is what keeps cancel available', () => {
    // `isTransientGenerationStatus` is the cancel-generation gate on
    // POST /api/tests/draft/:id/cancel-generation. Mapping an in-progress stage
    // to anything else would 409 the user's stop control on a draft whose agent
    // is still writing specs in their own client window.
    const inProgress: ExternalDraftStage[] = ['scaffolding', 'authoring-tests', 'validating']

    for (const stage of inProgress) {
      expect(statusForExternalStage(stage)).toBe('generating')
      expect(isTransientGenerationStatus(statusForExternalStage(stage))).toBe(true)
    }
    expect(isTransientGenerationStatus(statusForExternalStage('ready'))).toBe(false)
  })
})

describe('externalDraftView', () => {
  function draftRecord(over: Partial<DraftRecord> = {}): DraftRecord {
    return {
      draftId: 'draft-abc-123456',
      prdText: 'External agent session is authoring tests for checkout.',
      prdDocuments: [],
      repos: [],
      featureName: 'checkout',
      producer: 'external',
      externalStage: 'authoring-tests',
      externalClientKind: 'claude',
      externalSessionId: 'sess-1',
      externalConversationName: 'Checkout specs',
      externalSessionUrl: 'https://claude.ai/chat/abc',
      status: 'generating',
      createdAt: '2026-05-25T08:00:00.000Z',
      updatedAt: '2026-05-25T08:05:00.000Z',
      ...over,
    } as DraftRecord
  }

  it('reports the draft under both feature keys the clients read', () => {
    // `feature` and `featureName` are the same value deliberately: the tool
    // results everywhere else key on `feature`, and the draft record's own field
    // is `featureName`. Dropping either renames a field in a shipped result.
    expect(externalDraftView(draftRecord())).toEqual({
      draftId: 'draft-abc-123456',
      feature: 'checkout',
      featureName: 'checkout',
      producer: 'external',
      externalStage: 'authoring-tests',
      status: 'generating',
      clientKind: 'claude',
      sessionId: 'sess-1',
      conversationName: 'Checkout specs',
      externalSessionUrl: 'https://claude.ai/chat/abc',
      createdAt: '2026-05-25T08:00:00.000Z',
      updatedAt: '2026-05-25T08:05:00.000Z',
    })
  })

  it('does not carry the raw PRD text or the authored file list into the result', () => {
    // The record holds the whole PRD and every generated file path; the view is
    // what an agent reads on every stage poll, so it stays a status envelope.
    const view = externalDraftView(draftRecord({ generatedFiles: ['e2e/checkout.spec.ts'] }))

    expect(view.prdText).toBeUndefined()
    expect(view.generatedFiles).toBeUndefined()
  })

  it('calls a draft with no recorded producer internal', () => {
    // Drafts written before the external/internal split have no producer, and
    // both draft tools refuse a non-external draft — so the absent case has to
    // read as `internal` rather than as undefined.
    expect(externalDraftView(draftRecord({ producer: undefined })).producer).toBe('internal')
  })

  it('omits errorMessage unless the draft actually failed', () => {
    expect('errorMessage' in externalDraftView(draftRecord())).toBe(false)
    expect(externalDraftView(draftRecord({
      externalStage: 'error', status: 'error', errorMessage: 'spec did not compile',
    })).errorMessage).toBe('spec did not compile')
  })
})

describe('externalDraftAuthoringNextSteps', () => {
  it('names the feature-scoped spec directory and both progress calls', () => {
    const steps = externalDraftAuthoringNextSteps('checkout')

    expect(steps).toContain('Author or edit Playwright specs under features/checkout/e2e.')
    expect(steps.some((step) => step.includes('update_external_draft_stage'))).toBe(true)
    expect(steps.some((step) => step.includes('apply_external_draft'))).toBe(true)
  })
})

describe('newDraftId', () => {
  it('mints a distinct id that is safe to use as a directory name', () => {
    // The id becomes `<logsDir>/drafts/<draftId>/` (draft-store paths()), so a
    // separator or a collision would either escape the logs dir or have two
    // authoring sessions overwrite each other's record.
    const ids = new Set(Array.from({ length: 50 }, () => newDraftId()))

    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^draft-[0-9a-z]+-[0-9a-z]{6}$/)
  })
})
