import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canTransition,
  createDraft,
  deleteDraft,
  draftStatusOf,
  IllegalTransitionError,
  listDrafts,
  paths,
  readDraft,
  reconcileInterruptedDrafts,
  renameDraftFeature,
  transition,
  validateFeatureTarget,
  writeDraft,
} from './draft-store'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-store-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const baseInput = {
  draftId: '2026-04-29T1500-aaaa',
  prdText: 'Login flow.\n\nUsers should be able to sign in with email and password.',
  repos: [{ name: 'app', localPath: '/x/y' }],
}

describe('paths', () => {
  it('derives all per-draft paths', () => {
    const p = paths('/logs', 'd1')
    expect(p.draftDir).toBe('/logs/drafts/d1')
    expect(p.draftJson).toBe('/logs/drafts/d1/draft.json')
    expect(p.prdMd).toBe('/logs/drafts/d1/prd.md')
    expect(p.planJson).toBe('/logs/drafts/d1/plan.json')
    expect(p.planAgentLog).toBe('/logs/drafts/d1/plan-agent.log')
    expect(p.specAgentLog).toBe('/logs/drafts/d1/spec-agent.log')
    expect(p.generatedDir).toBe('/logs/drafts/d1/generated')
  })
})

describe('createDraft', () => {
  it('creates the draft dir and writes prd + state', () => {
    const rec = createDraft(tmp, { ...baseInput, now: () => '2026-04-29T15:00:00Z' })
    expect(rec.status).toBe('created')
    expect(rec.createdAt).toBe('2026-04-29T15:00:00Z')
    const p = paths(tmp, baseInput.draftId)
    expect(fs.existsSync(p.prdMd)).toBe(true)
    expect(fs.readFileSync(p.prdMd, 'utf8')).toBe(baseInput.prdText)
    expect(JSON.parse(fs.readFileSync(p.draftJson, 'utf8')).status).toBe('created')
  })

  it('honors provided featureName', () => {
    const rec = createDraft(tmp, { ...baseInput, featureName: 'login_flow' })
    expect(rec.featureName).toBe('login_flow')
  })
})

describe('readDraft / writeDraft', () => {
  it('returns null for unknown draft', () => {
    expect(readDraft(tmp, 'nope')).toBeNull()
  })

  it('round-trips a record', () => {
    const rec = createDraft(tmp, baseInput)
    const back = readDraft(tmp, rec.draftId)
    expect(back?.draftId).toBe(rec.draftId)
  })

  it('writeDraft updates updatedAt', () => {
    const rec = createDraft(tmp, baseInput)
    const orig = rec.updatedAt
    // wait a tick so the timestamp differs
    const next = { ...rec, status: 'planning' as const }
    writeDraft(tmp, next, () => '2099-01-01T00:00:00Z')
    const back = readDraft(tmp, rec.draftId)!
    expect(back.updatedAt).toBe('2099-01-01T00:00:00Z')
    expect(back.updatedAt).not.toBe(orig)
  })
})

describe('listDrafts', () => {
  it('returns empty when drafts dir absent', () => {
    expect(listDrafts(tmp)).toEqual([])
  })

  it('lists drafts newest first by createdAt', () => {
    createDraft(tmp, { ...baseInput, draftId: 'a', now: () => '2026-04-29T10:00:00Z' })
    createDraft(tmp, { ...baseInput, draftId: 'b', now: () => '2026-04-29T12:00:00Z' })
    createDraft(tmp, { ...baseInput, draftId: 'c', now: () => '2026-04-29T11:00:00Z' })
    const list = listDrafts(tmp)
    expect(list.map((d) => d.draftId)).toEqual(['b', 'c', 'a'])
  })

  it('skips non-directories and unparseable entries', () => {
    fs.mkdirSync(path.join(tmp, 'drafts'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'drafts', 'random.txt'), 'not a draft', 'utf8')
    expect(listDrafts(tmp)).toEqual([])
  })

  it('skips draft directories whose record file is missing', () => {
    // A directory under drafts/ without the expected draft.json — readDraft
    // returns null and listDrafts should silently skip the entry.
    fs.mkdirSync(path.join(tmp, 'drafts', 'orphan'), { recursive: true })
    expect(listDrafts(tmp)).toEqual([])
  })
})

describe('canTransition', () => {
  it('allows valid transitions', () => {
    expect(canTransition('created', 'planning')).toBe(true)
    expect(canTransition('planning', 'cancelled')).toBe(true)
    expect(canTransition('cancelled', 'rejected')).toBe(true)
    expect(canTransition('plan-ready', 'generating')).toBe(true)
    expect(canTransition('spec-ready', 'accepted')).toBe(true)
    expect(canTransition('error', 'rejected')).toBe(true)
  })
  it('rejects invalid transitions', () => {
    expect(canTransition('created', 'accepted')).toBe(false)
    expect(canTransition('accepted', 'rejected')).toBe(false)
    expect(canTransition('rejected', 'planning')).toBe(false)
  })
})

describe('transition', () => {
  it('updates status and patch fields', () => {
    createDraft(tmp, baseInput)
    const next = transition(tmp, baseInput.draftId, 'planning')
    expect(next.status).toBe('planning')
  })

  it('throws on illegal transition', () => {
    createDraft(tmp, baseInput)
    expect(() => transition(tmp, baseInput.draftId, 'accepted')).toThrow(IllegalTransitionError)
  })

  it('throws on missing draft', () => {
    expect(() => transition(tmp, 'nope', 'planning')).toThrow(/not found/)
  })

  it('applies patch fields', () => {
    createDraft(tmp, baseInput)
    transition(tmp, baseInput.draftId, 'planning')
    const next = transition(tmp, baseInput.draftId, 'plan-ready', { plan: [{ step: 'x' }] })
    expect(next.plan).toEqual([{ step: 'x' }])
  })

  it('records error message', () => {
    createDraft(tmp, baseInput)
    const next = transition(tmp, baseInput.draftId, 'error', { errorMessage: 'parse failed' })
    expect(next.errorMessage).toBe('parse failed')
  })
})

describe('deleteDraft', () => {
  it('returns false when dir missing', () => {
    expect(deleteDraft(tmp, 'nope')).toBe(false)
  })
  it('removes the dir', () => {
    createDraft(tmp, baseInput)
    expect(deleteDraft(tmp, baseInput.draftId)).toBe(true)
    expect(readDraft(tmp, baseInput.draftId)).toBeNull()
  })
  it('idOfEntry falls back to draftId for legacy index rows that lack an id field', () => {
    createDraft(tmp, baseInput)
    const indexPath = path.join(tmp, 'drafts', 'index.json')
    const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    const legacy = entries.map(({ id: _id, ...rest }: Record<string, unknown>) => rest)
    fs.writeFileSync(indexPath, JSON.stringify(legacy))
    deleteDraft(tmp, baseInput.draftId)
    expect(readDraft(tmp, baseInput.draftId)).toBeNull()
  })
})

describe('validateFeatureTarget', () => {
  it('returns the target feature directory when it is available', () => {
    const r = validateFeatureTarget(tmp, 'checkout_flow')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.featureDir).toBe(path.join(tmp, 'features', 'checkout_flow'))
  })

  it('checks feature name and existing directory without writing files', () => {
    expect(validateFeatureTarget(tmp, 'bad name').ok).toBe(false)
    fs.mkdirSync(path.join(tmp, 'features', 'login'), { recursive: true })
    const existing = validateFeatureTarget(tmp, 'login')
    expect(existing.ok).toBe(false)
    if (existing.ok) return
    expect(existing.error).toBe('feature-exists')
  })
})

describe('draftStatusOf', () => {
  it('draftStatusOf returns the record status', () => {
    expect(draftStatusOf({ status: 'created' } as any)).toBe('created')
    expect(draftStatusOf({ status: 'spec-ready' } as any)).toBe('spec-ready')
  })
})

describe('reconcileInterruptedDrafts (boot crash recovery)', () => {
  const mk = (draftId: string, status: 'generating' | 'planning' | 'accepted', producer?: 'external'): void => {
    const rec = createDraft(tmp, { ...baseInput, draftId })
    writeDraft(tmp, { ...rec, status, ...(producer ? { producer } : {}) })
  }

  it('flips server-spawned planning/generating to error; external + settled drafts stay', () => {
    mk('d-gen', 'generating')
    mk('d-plan', 'planning')
    mk('d-ext', 'generating', 'external')
    mk('d-done', 'accepted')
    reconcileInterruptedDrafts(tmp, () => '2026-01-02T00:00:00Z')
    expect(readDraft(tmp, 'd-gen')?.status).toBe('error')
    expect(readDraft(tmp, 'd-gen')?.errorMessage).toContain('server restart')
    expect(readDraft(tmp, 'd-plan')?.status).toBe('error')
    // An external draft is another process's live session — never touched.
    expect(readDraft(tmp, 'd-ext')?.status).toBe('generating')
    expect(readDraft(tmp, 'd-done')?.status).toBe('accepted')
  })
})

describe('renameDraftFeature', () => {
  it('re-homes drafts that target the renamed suite and reports the count', () => {
    // A draft still authoring against the old name would apply into a suite
    // that no longer exists, so a rename has to follow it.
    createDraft(tmp, { ...baseInput, draftId: 'd1', featureName: 'old_name' })
    createDraft(tmp, { ...baseInput, draftId: 'd2', featureName: 'old_name' })
    createDraft(tmp, { ...baseInput, draftId: 'd3', featureName: 'other' })

    expect(renameDraftFeature(tmp, 'old_name', 'new_name')).toBe(2)
    expect(readDraft(tmp, 'd1')?.featureName).toBe('new_name')
    expect(readDraft(tmp, 'd2')?.featureName).toBe('new_name')
    expect(readDraft(tmp, 'd3')?.featureName).toBe('other')
  })

  it('is a no-op when no draft targets the old name', () => {
    createDraft(tmp, { ...baseInput, draftId: 'd1', featureName: 'kept' })
    expect(renameDraftFeature(tmp, 'absent', 'new_name')).toBe(0)
    expect(readDraft(tmp, 'd1')?.featureName).toBe('kept')
  })
})
