import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'
import type {
  PathType,
  PrdSummary,
  Requirement,
  StrictnessLadderRung,
  StrictnessTier,
  VariantDimension,
  VariantNA,
} from '../../../../../../../shared/coverage/types'
import { type DocsCollection } from './docs-collection'
import { withFingerprints } from './fingerprints'
import { summarizePrd } from './prd-summary'

export const PATH_TYPES: PathType[] = ['happy', 'sad', 'edge']

export const TIERS: StrictnessTier[] = [1, 2, 3, 4]

/** The agent's per-requirement shape before canary assigns stable ids. */
export interface ParsedRequirement {
  /** The agent's echoed id (a previous id it believes survives). May be absent. */
  id?: string
  kind?: 'functional' | 'non-functional'
  title: string
  text: string
  happyPath?: string
  unhappyPath?: string
  pathTypes: PathType[]
  variants?: string[]
  variantsNA?: VariantNA[]
  strictnessLadder?: StrictnessLadderRung[]
}

export function normalizeKind(value: unknown): 'functional' | 'non-functional' | undefined {
  return value === 'functional' || value === 'non-functional' ? value : undefined
}

/** Normalize a token to a variant value: lower-case, trimmed, single token. */
export function normalizeVariantValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  return v ? v : undefined
}

/** Parse the agent's top-level `variantDimension`. Requires a non-empty name and
 *  at least TWO values — a one-value "dimension" carries no breadth and is
 *  dropped (it would just be a noisy variant-agnostic requirement). */
export function normalizeVariantDimension(value: unknown): VariantDimension | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { name?: unknown; values?: unknown }
  const name = normalizeVariantValue(raw.name)
  if (!name || !Array.isArray(raw.values)) return undefined
  const values: string[] = []
  for (const item of raw.values) {
    const v = normalizeVariantValue(item)
    if (v && !values.includes(v)) values.push(v)
  }
  return values.length >= 2 ? { name, values } : undefined
}

/** Normalize a requirement's `variants`, dropping anything outside the feature's
 *  declared dimension (the controlled vocabulary). Returns undefined when the
 *  requirement spans fewer than 2 declared values — there's no breadth to track. */
export function normalizeRequirementVariants(value: unknown, dimension: VariantDimension | undefined): string[] | undefined {
  if (!dimension || !Array.isArray(value)) return undefined
  const allowed = new Set(dimension.values)
  const out: string[] = []
  for (const item of value) {
    const v = normalizeVariantValue(item)
    if (v && allowed.has(v) && !out.includes(v)) out.push(v)
  }
  return out.length >= 2 ? out : undefined
}

/** Normalize a requirement's `variantsNA` — variants it nominally spans but that
 *  have no testable surface. Each must be one of the requirement's declared
 *  `variants` and carry a non-empty reason; anything else is dropped. */
export function normalizeRequirementVariantsNA(
  value: unknown,
  declared: string[] | undefined,
): VariantNA[] | undefined {
  if (!Array.isArray(value) || !declared || !declared.length) return undefined
  const allowed = new Set(declared)
  const seen = new Set<string>()
  const out: VariantNA[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as { variant?: unknown; reason?: unknown }
    const variant = normalizeVariantValue(raw.variant)
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
    if (variant && reason && allowed.has(variant) && !seen.has(variant)) {
      seen.add(variant)
      out.push({ variant, reason })
    }
  }
  return out.length ? out : undefined
}

export function normalizeProse(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Normalization of agent / fallback output
// ---------------------------------------------------------------------------

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function normalizePathTypes(value: unknown): PathType[] {
  if (!Array.isArray(value)) return ['happy']
  const seen = new Set<PathType>()
  for (const item of value) {
    if (typeof item === 'string' && (PATH_TYPES as string[]).includes(item)) {
      seen.add(item as PathType)
    }
  }
  // Order canonically; default to happy when the agent gave nothing usable.
  const ordered = PATH_TYPES.filter((p) => seen.has(p))
  return ordered.length ? ordered : ['happy']
}

export function normalizeLadder(value: unknown): StrictnessLadderRung[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rungs: StrictnessLadderRung[] = []
  const seenTiers = new Set<StrictnessTier>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const rung = item as { tier?: unknown; description?: unknown }
    const tier = rung.tier
    if (typeof tier !== 'number' || !(TIERS as number[]).includes(tier)) continue
    if (seenTiers.has(tier as StrictnessTier)) continue
    if (typeof rung.description !== 'string' || !rung.description.trim()) continue
    seenTiers.add(tier as StrictnessTier)
    rungs.push({ tier: tier as StrictnessTier, description: rung.description.trim() })
  }
  rungs.sort((a, b) => a.tier - b.tier)
  return rungs.length ? rungs : undefined
}

export function parseTopLevelObject(output: string): Record<string, unknown> | null {
  // The real answer envelope always carries a `requirements` array (the schema
  // requires it), so anchor on that — a stray parseable object in the agent's
  // prose (inline code, placeholders) can't shadow it. Fall back to the first
  // plain object so a shape-drifted answer still degrades like before.
  let firstObject: Record<string, unknown> | null = null
  for (const c of extractJsonCandidates(output)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue
    const o = c as Record<string, unknown>
    if (Array.isArray(o.requirements)) return o
    firstObject ??= o
  }
  return firstObject
}

/** Parse the agent's top-level `variantDimension` (D1) from the output, if any.
 *  Separate from `parsePrdSummaryOutput` so the latter keeps its array contract;
 *  pass the result back in to validate each requirement's `variants`. */
export function parseVariantDimension(output: string): VariantDimension | undefined {
  const parsed = parseTopLevelObject(output)
  return parsed ? normalizeVariantDimension(parsed.variantDimension) : undefined
}

/** Parse raw agent stdout into requirement candidates. Returns null on garbage.
 *  `variantDimension` (when supplied) is the closed vocabulary a requirement's
 *  `variants` is validated against. */
export function parsePrdSummaryOutput(
  output: string,
  variantDimension?: VariantDimension,
): ParsedRequirement[] | null {
  const parsed = parseTopLevelObject(output)
  if (!parsed) return null
  const reqs = parsed.requirements
  if (!Array.isArray(reqs)) return null
  const out: ParsedRequirement[] = []
  for (const raw of reqs) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string' || typeof r.text !== 'string') continue
    if (!r.title.trim() || !r.text.trim()) continue
    const variants = normalizeRequirementVariants(r.variants, variantDimension)
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : undefined,
      kind: normalizeKind(r.kind),
      title: r.title.trim(),
      text: r.text.trim(),
      happyPath: normalizeProse(r.happyPath),
      unhappyPath: normalizeProse(r.unhappyPath),
      pathTypes: normalizePathTypes(r.pathTypes),
      variants,
      variantsNA: normalizeRequirementVariantsNA(r.variantsNA, variants),
      strictnessLadder: normalizeLadder(r.strictnessLadder),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The id spine — deterministic, canary-owned. Highest-risk invariant.
// ---------------------------------------------------------------------------

export function maxIdNumber(ids: Iterable<string>): number {
  let max = 0
  for (const id of ids) {
    const m = /^R(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

/**
 * Assign stable ids to a freshly-parsed requirement list, preserving the ids of
 * surviving requirements. Survivorship is decided by, in priority order:
 *   1. an echoed id that matches a previous requirement,
 *   2. an exact normalized-title match to an unused previous requirement.
 * Anything else gets a fresh `R<n>` beyond every existing id. Previous
 * requirements that survive nothing are carried over as `deprecated` (kept, not
 * deleted) so dangling `@requirement` annotations still resolve.
 */
export function reconcileRequirementIds(
  previous: Requirement[],
  parsed: ParsedRequirement[],
): Requirement[] {
  const prevById = new Map(previous.map((r) => [r.id, r]))
  const prevByTitle = new Map<string, Requirement>()
  for (const r of previous) {
    const key = normalizeTitle(r.title)
    if (!prevByTitle.has(key)) prevByTitle.set(key, r)
  }
  const usedPrevIds = new Set<string>()
  const assignedIds = new Set<string>(prevById.keys())
  let counter = maxIdNumber(prevById.keys())

  const freshId = (): string => {
    let id: string
    do {
      counter += 1
      id = `R${counter}`
    } while (assignedIds.has(id))
    assignedIds.add(id)
    return id
  }

  const out: Requirement[] = []
  for (const candidate of parsed) {
    let id: string | undefined
    if (candidate.id && prevById.has(candidate.id) && !usedPrevIds.has(candidate.id)) {
      id = candidate.id
    } else {
      const titleMatch = prevByTitle.get(normalizeTitle(candidate.title))
      if (titleMatch && !usedPrevIds.has(titleMatch.id)) id = titleMatch.id
    }
    let survivedFrom: Requirement | undefined
    if (id) {
      usedPrevIds.add(id)
      survivedFrom = prevById.get(id)
    } else {
      id = freshId()
    }

    out.push({
      id,
      kind: candidate.kind ?? survivedFrom?.kind,
      title: candidate.title,
      text: candidate.text,
      happyPath: candidate.happyPath ?? survivedFrom?.happyPath,
      unhappyPath: candidate.unhappyPath ?? survivedFrom?.unhappyPath,
      pathTypes: candidate.pathTypes,
      // Variants are freshly re-extracted each regen; fall back to a survivor's
      // set only when this pass proposed none (parallels the ladder).
      variants: candidate.variants ?? survivedFrom?.variants,
      variantsNA: candidate.variantsNA ?? survivedFrom?.variantsNA,
      // The strictness ladder is per-domain and stable; preserve a survivor's
      // existing ladder when the regen doesn't re-propose one (parallels id
      // preservation — agents shouldn't have to re-derive it every time).
      strictnessLadder: candidate.strictnessLadder ?? survivedFrom?.strictnessLadder,
    })
  }

  // Carry over un-matched previous requirements as deprecated so their ids — and
  // any annotations pointing at them — keep resolving.
  for (const prev of previous) {
    if (usedPrevIds.has(prev.id)) continue
    out.push({ ...prev, deprecated: true })
  }
  return out
}

/**
 * Assemble a `PrdSummary` from freshly-parsed requirements: reconcile ids against
 * `previous` (the stable spine), stamp docs hash / source-doc list / timestamp,
 * and persist per-doc + per-requirement fingerprints. The single home for turning
 * a `ParsedRequirement[]` into a stored summary — shared by the internal
 * agent-backed `summarizePrd` and the offloaded `applyExternalSummary`, so the
 * id-spine invariant (R: never trust the agent to renumber) holds on both paths.
 */
export function assembleSummary(
  collection: DocsCollection,
  previous: PrdSummary | null,
  parsed: ParsedRequirement[],
  variantDimension?: VariantDimension,
  now?: string,
): PrdSummary {
  const requirements = reconcileRequirementIds(previous?.requirements ?? [], parsed)
  // Preserve a prior dimension when this pass didn't re-declare one (stability,
  // like requirement ids) — but a freshly-declared dimension always wins.
  const dimension = variantDimension ?? previous?.variantDimension
  const summary: PrdSummary = {
    requirements,
    ...(dimension ? { variantDimension: dimension } : {}),
    docsHash: collection.docsHash,
    sourceDocs: collection.entries.map((e) => e.relPath),
    generatedAt: now ?? new Date().toISOString(),
  }
  return withFingerprints(summary, collection.entries)
}
