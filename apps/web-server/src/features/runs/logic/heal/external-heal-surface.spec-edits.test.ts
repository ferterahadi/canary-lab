import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunDetail } from '../run-store'
import type { RunManifest } from '../runtime/manifest'
import { INTEGRITY_HINT_DISCLOSURE, type IntegrityHint } from '../runtime/run-integrity-hints'
import { buildExternalRunSnapshot, buildSpecEditsWarning } from './external-heal-surface'

// The specEdits warning is the agent-facing reading of the D9 boundary: the
// run executed the run-start copy of the suite, so a live edit made after that
// point was never tested. The warning is advisory — it names the edits and the
// hints, and points at the two honest exits (restore, or ask the human to
// adopt). It never gates: nothing here is consulted by the verdict.

let tmpDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-spec-edits-warning-')))
  logsDir = path.join(tmpDir, 'logs')
})

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1',
    feature: 'checkout',
    env: 'local',
    startedAt: '2026-05-25T08:00:00.000Z',
    status: 'passed',
    healCycles: 0,
    services: [],
    ...over,
  }
}

const weakerHint: IntegrityHint = {
  kind: 'weaker',
  file: 'e2e/voucher.spec.ts',
  test: 'applies voucher',
  requirements: ['req-voucher-1'],
  was: ['expect(total).toBe(90)'],
  now: [],
}

function withPending(over: Partial<RunManifest> = {}): RunManifest {
  return manifest({
    specEdits: {
      checkedAt: '2026-05-25T08:05:00.000Z',
      pending: [
        {
          file: 'e2e/voucher.spec.ts',
          change: 'modified',
          affectedTests: ['applies voucher'],
          strength: { verdict: 'weaker', tests: [], baseline: 'run-start' },
        },
        { file: 'e2e/new.spec.ts', change: 'added', affectedTests: ['brand new'] },
      ],
      adopted: [],
    },
    integrity: { hints: [weakerHint], disclosure: INTEGRITY_HINT_DISCLOSURE },
    ...over,
  })
}

describe('buildSpecEditsWarning', () => {
  it('is absent when the run recorded no spec edits at all', () => {
    // No snapshot means no boundary to measure against; saying "no edits"
    // would overstate what the run knows.
    expect(buildSpecEditsWarning(manifest())).toBeUndefined()
  })

  it('is absent when every recorded edit was adopted', () => {
    const m = manifest({
      specEdits: { checkedAt: 't', pending: [], adopted: [{ at: 't', files: ['e2e/voucher.spec.ts'] }] },
      integrity: { hints: [], disclosure: INTEGRITY_HINT_DISCLOSURE },
    })
    expect(buildSpecEditsWarning(m)).toBeUndefined()
  })

  it('slims each pending edit to its path, change kind, tests and verdict', () => {
    const warning = buildSpecEditsWarning(withPending())

    expect(warning?.pending).toEqual([
      { file: 'e2e/voucher.spec.ts', change: 'modified', affectedTests: ['applies voucher'], verdict: 'weaker' },
      { file: 'e2e/new.spec.ts', change: 'added', affectedTests: ['brand new'] },
    ])
    // The raw differential (per-test changes, before/after predicates) stays
    // on the manifest; the hints already carry the part worth an agent's eye.
    expect(JSON.stringify(warning)).not.toContain('"strength"')
  })

  it('carries the hints verbatim, with the disclosure beside them', () => {
    const warning = buildSpecEditsWarning(withPending())

    expect(warning?.hints).toEqual([weakerHint])
    expect(warning?.disclosure).toBe(INTEGRITY_HINT_DISCLOSURE)
  })

  it('says the edits were never tested, and offers only restore or a human adopt', () => {
    const warning = buildSpecEditsWarning(withPending())

    expect(warning?.message).toContain('2 spec files changed after this run started')
    expect(warning?.message).toContain('none of these edits was tested')
    const steps = warning?.nextSteps.join('\n') ?? ''
    expect(steps).toContain('Restore')
    expect(steps).toContain('ask the human to adopt')
    expect(steps).toContain('No MCP tool can adopt or approve')
  })

  it('names a weaker hint and orders the restore, never an edit of the test', () => {
    const warning = buildSpecEditsWarning(withPending())

    const weakerStep = warning?.nextSteps.find((s) => s.includes('weaker'))
    expect(weakerStep).toContain('e2e/voucher.spec.ts › applies voucher')
    expect(weakerStep).toContain('Restore')
    expect(weakerStep).toContain('never a repair')
  })

  it('has no weaker step when the hints carry none', () => {
    const warning = buildSpecEditsWarning(withPending({
      integrity: {
        hints: [{ kind: 'cannot-classify', file: 'e2e/new.spec.ts', reason: 'new file' }],
        disclosure: INTEGRITY_HINT_DISCLOSURE,
      },
    }))

    expect(warning?.nextSteps.some((s) => s.includes('weaker'))).toBe(false)
    expect(warning?.hints).toHaveLength(1)
  })

  it('reads a run without an integrity block as hint-free, singular in the message', () => {
    const m = withPending({ integrity: undefined })
    m.specEdits!.pending = [m.specEdits!.pending[0]]
    delete m.integrity

    const warning = buildSpecEditsWarning(m)

    expect(warning?.hints).toEqual([])
    expect(warning?.disclosure).toBe(INTEGRITY_HINT_DISCLOSURE)
    expect(warning?.message).toContain('1 spec file changed')
  })
})

describe('buildExternalRunSnapshot — specEdits', () => {
  function detail(m: RunManifest): RunDetail {
    return { runId: m.runId, manifest: m, summary: null, lifecycleEvents: [], playwrightArtifacts: [], playbackEvents: [] } as unknown as RunDetail
  }

  it('carries the warning when edits are pending', () => {
    const snapshot = buildExternalRunSnapshot({ detail: detail(withPending()), logsDir })

    expect(snapshot.specEdits?.pending.map((p) => p.file)).toEqual(['e2e/voucher.spec.ts', 'e2e/new.spec.ts'])
    expect(snapshot.specEdits?.hints).toEqual([weakerHint])
  })

  it('omits the field when nothing is pending', () => {
    const snapshot = buildExternalRunSnapshot({ detail: detail(manifest()), logsDir })

    expect(snapshot).not.toHaveProperty('specEdits')
  })
})
