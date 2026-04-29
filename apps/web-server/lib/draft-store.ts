import fs from 'fs'
import path from 'path'

// Draft storage for the Add Test wizard. Each draft lives at
// `<logsDir>/drafts/<draftId>/` with a JSON state file plus the raw PRD,
// the agent's plan output, the generated spec files, and per-stage agent
// pty logs. State transitions are guarded by `transition()` so the route
// layer can't accidentally jump from `created` straight to `accepted`.
//
// All side effects are scoped to the draft directory — the only time we
// touch the project root is on `applyToProject`, which copies files into
// `features/<name>/`.

export type DraftStatus =
  | 'created'
  | 'recommending'
  | 'planning'
  | 'plan-ready'
  | 'generating'
  | 'spec-ready'
  | 'accepted'
  | 'rejected'
  | 'error'

const ALLOWED_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  created: ['recommending', 'planning', 'rejected', 'error'],
  recommending: ['planning', 'rejected', 'error'],
  planning: ['plan-ready', 'rejected', 'error'],
  'plan-ready': ['generating', 'rejected', 'error'],
  generating: ['spec-ready', 'rejected', 'error'],
  'spec-ready': ['accepted', 'rejected', 'error'],
  accepted: [],
  rejected: [],
  error: ['rejected'],
}

export interface DraftRepo {
  name: string
  localPath: string
}

export interface DraftRecord {
  draftId: string
  prdText: string
  repos: DraftRepo[]
  skills: string[]
  featureName?: string
  status: DraftStatus
  createdAt: string
  updatedAt: string
  plan?: unknown
  generatedFiles?: string[]
  errorMessage?: string
}

export interface DraftPaths {
  draftDir: string
  draftJson: string
  prdMd: string
  planJson: string
  planAgentLog: string
  specAgentLog: string
  generatedDir: string
}

export function paths(logsDir: string, draftId: string): DraftPaths {
  const draftDir = path.join(logsDir, 'drafts', draftId)
  return {
    draftDir,
    draftJson: path.join(draftDir, 'draft.json'),
    prdMd: path.join(draftDir, 'prd.md'),
    planJson: path.join(draftDir, 'plan.json'),
    planAgentLog: path.join(draftDir, 'plan-agent.log'),
    specAgentLog: path.join(draftDir, 'spec-agent.log'),
    generatedDir: path.join(draftDir, 'generated'),
  }
}

export interface CreateDraftInput {
  draftId: string
  prdText: string
  repos: DraftRepo[]
  skills?: string[]
  featureName?: string
  now?: () => string
}

export function createDraft(logsDir: string, input: CreateDraftInput): DraftRecord {
  const now = (input.now ?? (() => new Date().toISOString()))()
  const p = paths(logsDir, input.draftId)
  fs.mkdirSync(p.draftDir, { recursive: true })
  fs.writeFileSync(p.prdMd, input.prdText, 'utf8')
  const record: DraftRecord = {
    draftId: input.draftId,
    prdText: input.prdText,
    repos: input.repos,
    skills: input.skills ?? [],
    featureName: input.featureName,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  }
  writeDraft(logsDir, record)
  return record
}

export function readDraft(logsDir: string, draftId: string): DraftRecord | null {
  const p = paths(logsDir, draftId)
  if (!fs.existsSync(p.draftJson)) return null
  const raw = fs.readFileSync(p.draftJson, 'utf8')
  return JSON.parse(raw) as DraftRecord
}

export function writeDraft(logsDir: string, record: DraftRecord, now?: () => string): void {
  const p = paths(logsDir, record.draftId)
  fs.mkdirSync(p.draftDir, { recursive: true })
  const next: DraftRecord = { ...record, updatedAt: (now ?? (() => new Date().toISOString()))() }
  const tmp = `${p.draftJson}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, p.draftJson)
}

export function listDrafts(logsDir: string): DraftRecord[] {
  const dir = path.join(logsDir, 'drafts')
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out: DraftRecord[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const rec = readDraft(logsDir, e.name)
    if (rec) out.push(rec)
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: DraftStatus, public readonly to: DraftStatus) {
    super(`Illegal draft transition: ${from} → ${to}`)
  }
}

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export interface TransitionPatch {
  plan?: unknown
  generatedFiles?: string[]
  featureName?: string
  errorMessage?: string
}

export function transition(
  logsDir: string,
  draftId: string,
  to: DraftStatus,
  patch: TransitionPatch = {},
  now?: () => string,
): DraftRecord {
  const rec = readDraft(logsDir, draftId)
  if (!rec) throw new Error(`Draft ${draftId} not found`)
  if (!canTransition(rec.status, to)) throw new IllegalTransitionError(rec.status, to)
  const next: DraftRecord = { ...rec, ...patch, status: to }
  writeDraft(logsDir, next, now)
  return next
}

export function deleteDraft(logsDir: string, draftId: string): boolean {
  const p = paths(logsDir, draftId)
  if (!fs.existsSync(p.draftDir)) return false
  fs.rmSync(p.draftDir, { recursive: true, force: true })
  return true
}

export interface ApplyToProjectInput {
  draftId: string
  featureName: string
  generated: { path: string; content: string }[]
  projectRoot: string
}

export type ApplyToProjectResult =
  | { ok: true; featureDir: string; written: string[] }
  | { ok: false; error: 'feature-exists' | 'invalid-name'; featureDir?: string }

const FEATURE_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function applyToProject(input: ApplyToProjectInput): ApplyToProjectResult {
  if (!FEATURE_NAME_RE.test(input.featureName)) return { ok: false, error: 'invalid-name' }
  const featureDir = path.join(input.projectRoot, 'features', input.featureName)
  if (fs.existsSync(featureDir)) return { ok: false, error: 'feature-exists', featureDir }
  fs.mkdirSync(featureDir, { recursive: true })
  const written: string[] = []
  for (const f of input.generated) {
    const target = path.join(featureDir, f.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, f.content, 'utf8')
    written.push(target)
  }
  fs.writeFileSync(path.join(featureDir, '.canary-lab-draft-id'), input.draftId, 'utf8')
  return { ok: true, featureDir, written }
}

// Slugify a string into a feature name candidate. Used as a fallback when the
// user doesn't supply `featureName` — first 4 alpha words of the PRD title.
export function slugifyFeatureName(prdText: string): string {
  const firstLine = (prdText.split('\n').find((l) => l.trim()) ?? '').trim()
  const words = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 4)
  const slug = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug || 'untitled-feature'
}
