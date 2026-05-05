import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyToProject,
  canTransition,
  createDraft,
  deleteDraft,
  IllegalTransitionError,
  listDrafts,
  paths,
  readDraft,
  slugifyFeatureName,
  transition,
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
    expect(rec.skills).toEqual([])
    expect(rec.createdAt).toBe('2026-04-29T15:00:00Z')
    const p = paths(tmp, baseInput.draftId)
    expect(fs.existsSync(p.prdMd)).toBe(true)
    expect(fs.readFileSync(p.prdMd, 'utf8')).toBe(baseInput.prdText)
    expect(JSON.parse(fs.readFileSync(p.draftJson, 'utf8')).status).toBe('created')
  })

  it('honors provided featureName and skills', () => {
    const rec = createDraft(tmp, { ...baseInput, skills: ['s1', 's2'], featureName: 'login_flow' })
    expect(rec.featureName).toBe('login_flow')
    expect(rec.skills).toEqual(['s1', 's2'])
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
    const next = { ...rec, status: 'recommending' as const }
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
    expect(canTransition('created', 'recommending')).toBe(true)
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
})

describe('applyToProject', () => {
  it('writes all files into features/<name>/', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'))
    const r = applyToProject({
      draftId: 'd1',
      featureName: 'login',
      generated: [
        { path: 'feature.config.cjs', content: 'a' },
        { path: 'e2e/login.spec.ts', content: 'b' },
      ],
      projectRoot,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(fs.readFileSync(path.join(r.featureDir, 'feature.config.cjs'), 'utf8')).toBe('a')
    expect(fs.readFileSync(path.join(r.featureDir, 'e2e/login.spec.ts'), 'utf8')).toBe('b')
    expect(fs.readFileSync(path.join(r.featureDir, '.canary-lab-draft-id'), 'utf8')).toBe('d1')
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('refuses if feature dir already exists', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'))
    fs.mkdirSync(path.join(projectRoot, 'features', 'login'), { recursive: true })
    const r = applyToProject({
      draftId: 'd1',
      featureName: 'login',
      generated: [{ path: 'x.ts', content: 'a' }],
      projectRoot,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('feature-exists')
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects invalid feature names', () => {
    const r = applyToProject({
      draftId: 'd1',
      featureName: 'bad name!',
      generated: [],
      projectRoot: tmp,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid-name')
  })
})

describe('slugifyFeatureName', () => {
  it('takes first 4 words', () => {
    expect(slugifyFeatureName('Login Flow With OTP And Resend')).toBe('login-flow-with-otp')
  })
  it('strips punctuation', () => {
    expect(slugifyFeatureName('User authentication: redeems voucher!')).toBe('user-authentication-redeems-voucher')
  })
  it('uses first non-empty line', () => {
    expect(slugifyFeatureName('\n\n   \nLogin flow\nMore text\n')).toBe('login-flow')
  })
  it('falls back to untitled when empty', () => {
    expect(slugifyFeatureName('')).toBe('untitled-feature')
    expect(slugifyFeatureName('!!!')).toBe('untitled-feature')
  })
})
