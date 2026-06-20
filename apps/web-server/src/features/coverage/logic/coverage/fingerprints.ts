import crypto from 'crypto'
import type { DocEntry } from '../../../coverage/logic/coverage/docs-collection'
import type { PrdSummary, Requirement } from '../../../../../../../shared/coverage/types'

// Per-doc and per-requirement fingerprints (R3). The whole-collection `docsHash`
// answers "did ANY doc change?"; these finer prints answer "WHICH docs changed?"
// and "did the requirements SET change?" — the basis for naming affected
// artifacts now and (R10) re-inferring only changed requirements later.

function sha256(...parts: string[]): string {
  const h = crypto.createHash('sha256')
  for (const p of parts) {
    h.update(p)
    h.update('\0')
  }
  return h.digest('hex')
}

/** Stable fingerprint of one source doc (path + bytes). */
export function fingerprintDoc(entry: DocEntry): string {
  return sha256(entry.relPath, entry.content)
}

/** relPath → fingerprint over a docs collection (generated artifacts excluded
 *  upstream by readDocsCollection). */
export function fingerprintDocs(entries: DocEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) out[entry.relPath] = fingerprintDoc(entry)
  return out
}

/** Stable fingerprint of one requirement's MEANING (id excluded — the id is the
 *  durable spine; this captures whether its content shifted). */
export function fingerprintRequirement(req: Requirement): string {
  return sha256(req.title, req.text, [...req.pathTypes].sort().join(','))
}

/** Hash over the ACTIVE requirements set (id + content fingerprint), order-
 *  independent. Changes when a requirement is added, removed, or edited — the key
 *  coverage staleness is measured against. */
export function requirementsSetHash(requirements: Requirement[]): string {
  const active = requirements
    .filter((r) => !r.deprecated)
    .map((r) => `${r.id}:${fingerprintRequirement(r)}`)
    .sort()
  return sha256(...active)
}

export interface DocsDelta {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

/** Compare the live docs against the fingerprints stored at last generation.
 *  Empty `previous` (older summary without prints) → everything counts as added
 *  so the user is still told the summary is out of date. */
export function diffDocs(
  live: Record<string, string>,
  previous: Record<string, string> | undefined,
): DocsDelta {
  const prev = previous ?? {}
  const delta: DocsDelta = { added: [], removed: [], changed: [], unchanged: [] }
  for (const [rel, hash] of Object.entries(live)) {
    if (!(rel in prev)) delta.added.push(rel)
    else if (prev[rel] !== hash) delta.changed.push(rel)
    else delta.unchanged.push(rel)
  }
  for (const rel of Object.keys(prev)) {
    if (!(rel in live)) delta.removed.push(rel)
  }
  for (const k of ['added', 'removed', 'changed', 'unchanged'] as const) delta[k].sort()
  return delta
}

/** Source docs whose presence/content differs from the stored summary. */
export function changedDocPaths(delta: DocsDelta): string[] {
  return [...delta.added, ...delta.changed, ...delta.removed].sort()
}

/** id → content fingerprint over the active requirements. */
export function requirementFingerprintMap(requirements: Requirement[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of requirements) {
    if (r.deprecated) continue
    out[r.id] = r.fingerprint ?? fingerprintRequirement(r)
  }
  return out
}

/** Active requirement ids whose fingerprint is new or changed vs a baseline map.
 *  Empty `previous` → all active ids (first run / no baseline). */
export function changedRequirementIds(
  requirements: Requirement[],
  previous: Record<string, string> | undefined,
): string[] {
  const live = requirementFingerprintMap(requirements)
  const prev = previous ?? {}
  const changed: string[] = []
  for (const [id, fp] of Object.entries(live)) {
    if (!(id in prev) || prev[id] !== fp) changed.push(id)
  }
  return changed.sort()
}

/** Attach fingerprints to a summary at write time (id-stable; content-keyed). */
export function withFingerprints(summary: PrdSummary, entries: DocEntry[]): PrdSummary {
  return {
    ...summary,
    docFingerprints: fingerprintDocs(entries),
    requirementsHash: requirementsSetHash(summary.requirements),
    requirements: summary.requirements.map((r) => ({ ...r, fingerprint: fingerprintRequirement(r) })),
  }
}
