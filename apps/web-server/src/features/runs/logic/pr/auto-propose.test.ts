import { describe, it, expect } from 'vitest'
import { autoProposeFixes, shouldAutoPropose } from './auto-propose'
import type { RunContext } from '../runtime/run-context'
import type { RunFixCapture, RunManifest } from '../runtime/manifest'
import type { ProjectConfig } from '../runtime/launcher/project-config'
import type { PrPreflight } from './pr-preflight'

const capture: RunFixCapture = {
  capturedAt: 'now',
  repos: [{ repoName: 'fnb', patchPath: '/r/fixes/fnb.patch', patchFile: 'fnb.patch', repoRoot: '/repos/fnb', baseSha: 'base1', files: 2 }],
}

const preflight: PrPreflight = {
  gh: { installed: true, authenticated: true, account: 'me', host: 'github.com' },
  anyPushable: true,
  repos: [{ repoName: 'fnb', repoRoot: '/repos/fnb', origin: { owner: 'org', name: 'fnb', host: 'github.com' }, base: 'main', pushable: true }],
}

const config: ProjectConfig = { healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true }

/** A teardown-shaped context: only the fields auto-propose actually reads. */
function mkCtx(over: Partial<RunContext> = {}) {
  const patches: Partial<RunManifest>[] = []
  const warnings: string[] = []
  const infos: string[] = []
  const ctx = {
    runId: 'run-1',
    feature: { name: 'fnb' },
    projectRoot: '/workspace',
    executionType: 'run',
    healCycles: 2,
    stateSink: { patchManifest: (_id: string, patch: Partial<RunManifest>) => { patches.push(patch) } },
    runnerLog: { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) },
    ...over,
  } as unknown as RunContext
  return { ctx, patches, warnings, infos }
}

describe('shouldAutoPropose', () => {
  const base = {
    capture,
    finalStatus: 'passed' as RunManifest['status'],
    executionType: 'run' as RunContext['executionType'],
    healCycles: 1,
    autoProposePr: true,
  }

  it('fires for a green test run that healed and captured a fix', () => {
    expect(shouldAutoPropose(base)).toBe(true)
  })

  it.each([
    ['the workspace turned it off', { autoProposePr: false }],
    ['it is a boot session, which never heals', { executionType: 'boot' as const }],
    ['it is a verification run', { executionType: 'verify' as const }],
    ['the run did not end green', { finalStatus: 'failed' as RunManifest['status'] }],
    ['the run was aborted', { finalStatus: 'aborted' as RunManifest['status'] }],
    ['no repair cycle ever ran', { healCycles: 0 }],
    ['nothing was captured', { capture: null }],
    ['the capture is empty', { capture: { capturedAt: 'now', repos: [] } }],
  ])('does not fire when %s', (_label, over) => {
    expect(shouldAutoPropose({ ...base, ...over })).toBe(false)
  })

  it('treats a run with no execution type as a test run', () => {
    expect(shouldAutoPropose({ ...base, executionType: undefined })).toBe(true)
  })
})

describe('autoProposeFixes', () => {
  it('opens a draft PR and records it on the manifest', async () => {
    const { ctx, patches, infos } = mkCtx()
    let sawDraft: boolean | undefined
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: {
        loadConfig: () => config,
        preflight: async () => preflight,
        propose: async (o) => {
          sawDraft = o.draft
          return [{ repoName: 'fnb', ok: true, pr: { repoName: 'fnb', url: 'https://gh/pr/1', branch: 'b', base: 'main', createdAt: 'T' } }]
        },
        now: () => 'T',
      },
    })
    expect(sawDraft).toBe(true)
    expect(patches).toEqual([{
      proposedPrs: [{ repoName: 'fnb', url: 'https://gh/pr/1', branch: 'b', base: 'main', createdAt: 'T' }],
      prAttempt: { at: 'T', auto: true, results: [{ repoName: 'fnb', ok: true, url: 'https://gh/pr/1' }] },
    }])
    expect(infos.some((m) => m.includes('https://gh/pr/1'))).toBe(true)
  })

  it('records why a repo opened nothing, and leaves proposedPrs alone', async () => {
    // The run still passed — GitHub being unreachable is reported, not raised.
    const { ctx, patches, warnings } = mkCtx()
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: {
        loadConfig: () => config,
        preflight: async () => ({ ...preflight, anyPushable: false }),
        propose: async () => [{ repoName: 'fnb', ok: false, reason: 'gh is not signed in' }],
        now: () => 'T',
      },
    })
    expect(patches).toEqual([{ prAttempt: { at: 'T', auto: true, results: [{ repoName: 'fnb', ok: false, reason: 'gh is not signed in' }] } }])
    expect(warnings.some((m) => m.includes('gh is not signed in'))).toBe(true)
  })

  it('reports an ok result that carries no PR object without inventing a url', async () => {
    const { ctx, patches, warnings } = mkCtx()
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: {
        loadConfig: () => config,
        preflight: async () => preflight,
        propose: async () => [{ repoName: 'fnb', ok: true }],
        now: () => 'T',
      },
    })
    expect(patches).toEqual([{ prAttempt: { at: 'T', auto: true, results: [{ repoName: 'fnb', ok: true }] } }])
    expect(warnings.some((m) => m.includes('unknown reason'))).toBe(true)
  })

  it('does nothing when the workspace turned auto-PR off', async () => {
    const { ctx, patches } = mkCtx()
    let proposed = false
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: {
        loadConfig: () => ({ ...config, autoProposePr: false }),
        preflight: async () => preflight,
        propose: async () => { proposed = true; return [] },
      },
    })
    expect(proposed).toBe(false)
    expect(patches).toEqual([])
  })

  it('does nothing without a project root — there is no consent to read', async () => {
    const { ctx, patches } = mkCtx({ projectRoot: undefined })
    let loaded = false
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: { loadConfig: () => { loaded = true; return config }, preflight: async () => preflight, propose: async () => [] },
    })
    expect(loaded).toBe(false)
    expect(patches).toEqual([])
  })

  it('does nothing on a red run even when a fix was captured', async () => {
    const { ctx, patches } = mkCtx()
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'failed',
      deps: { loadConfig: () => config, preflight: async () => preflight, propose: async () => [] },
    })
    expect(patches).toEqual([])
  })

  it('stamps a real timestamp when `now` is not injected', async () => {
    const { ctx, patches } = mkCtx()
    await autoProposeFixes({
      ctx,
      capture,
      finalStatus: 'passed',
      deps: {
        loadConfig: () => config,
        preflight: async () => preflight,
        propose: async () => [{ repoName: 'fnb', ok: false, reason: 'nope' }],
      },
    })
    expect(patches[0].prAttempt?.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })
})
