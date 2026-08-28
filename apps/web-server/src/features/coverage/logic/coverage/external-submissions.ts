import { z } from 'zod'
import type { ProposedMapping, VariantDimension } from '../../../../../../../shared/coverage/types'
import type { ParsedRequirement } from './prd-summary'

// What an EXTERNAL producer is allowed to hand back — the zod shapes for the
// PRD-summary and coverage-mapping submissions. Shared by the MCP submit_*
// tools (which validate at the tool's input-schema boundary) and the flight's
// external-work responders (which receive a checkpoint response as `unknown`
// and must validate by hand). One home so the two surfaces cannot drift on
// what a valid submission is — the exact split this module closes is a flight
// responder re-declaring "what a requirement looks like" three fields behind
// the tool schema.

// One mapping the offloaded client produces for submit_external_coverage —
// matches the internal annotate output shape (coverage-annotate.schema.json).
export const coverageMappingInput = z.object({
  testName: z.string().describe('Exact test name as given in the start context.'),
  requirements: z.array(z.string()).describe('Requirement id(s) this test verifies (e.g. ["R1"]). Unknown ids are dropped.'),
  pathTypes: z.array(z.enum(['happy', 'sad', 'edge'])).optional(),
  variants: z.array(z.string()).optional().describe('Variant value(s) this test exercises (e.g. ["email"]), from the suite\'s variant dimension. Values outside it are dropped. Omit for a variant-agnostic test.'),
  file: z.string().optional().describe('Relative spec path; omit and Canary resolves it by test name.'),
  rationale: z.string().optional(),
  confidence: z.number().optional(),
})

// One requirement an offloaded client proposes for an external PRD summary —
// mirrors prompts/prd-summary.schema.json (the shape the returned prompt asks
// for). Canary reconciles ids against the prior summary; never trust the agent's
// echoed id to renumber the spine.
export const summaryRequirementInput = z.object({
  id: z.string().optional().describe('Echo a prior requirement id to PRESERVE it; omit for a new requirement.'),
  kind: z.enum(['functional', 'non-functional']).optional(),
  title: z.string().describe('Short "it should …" title.'),
  text: z.string().describe('The requirement statement.'),
  happyPath: z.string().optional(),
  unhappyPath: z.string().optional(),
  pathTypes: z.array(z.enum(['happy', 'sad', 'edge'])).describe('At least one of happy/sad/edge.'),
  variants: z.array(z.string()).optional().describe('Variant value(s) this requirement must hold across (≥2 of the suite\'s variantDimension values, e.g. ["email","whatsapp"]). Omit for a single-value / variant-agnostic requirement.'),
  variantsNA: z.array(z.object({ variant: z.string(), reason: z.string() })).optional().describe('Variants from `variants` with NO testable surface (e.g. {variant:"line",reason:"no broadcast endpoint"}). Excluded from coverage + shown as N/A. Only when you confirmed the surface is absent — not merely untested.'),
  strictnessLadder: z.array(z.object({
    tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    description: z.string(),
  })).optional(),
})

// The feature-level variant dimension (D1) an offloaded client may declare on
// submit_external_summary — mirrors prompts/prd-summary.schema.json.
export const variantDimensionInput = z.object({
  name: z.string().describe('Lower-case single-token dimension name (e.g. "channel").'),
  values: z.array(z.string()).describe('Closed set of values a requirement may span (≥2, e.g. ["email","whatsapp","call","line"]).'),
})

/** The `data` payload a flight's prd-summary hand-off accepts on `submit`.
 *  `.min(1)` because an empty list can never satisfy the stage's
 *  ≥1-live-requirement predicate — rejecting it here means nothing is written
 *  to disk for a submission that was always going to re-park. */
export const summarySubmissionInput = z.object({
  requirements: z.array(summaryRequirementInput).min(1),
  variantDimension: variantDimensionInput.optional(),
})

export interface SummarySubmission {
  requirements: ParsedRequirement[]
  variantDimension?: VariantDimension
}

/** Validate a flight checkpoint's summary submission. The MCP twin gets this
 *  validation for free from its input schema; a checkpoint response crosses as
 *  `unknown`, so the flight responder calls this instead — same shapes, one
 *  verdict. The error is one line naming the first offending field: the client
 *  just has to answer the re-park again, and a full zod issue dump is noise. */
export function parseSummarySubmission(
  data: unknown,
): { ok: true; submission: SummarySubmission } | { ok: false; error: string } {
  const parsed = summarySubmissionInput.safeParse(data)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  return {
    ok: true,
    submission: {
      // Same widening the MCP tool performs on its schema-validated input —
      // the zod shape mirrors ParsedRequirement field-for-field.
      requirements: parsed.data.requirements as ParsedRequirement[],
      ...(parsed.data.variantDimension ? { variantDimension: parsed.data.variantDimension } : {}),
    },
  }
}

function firstIssue(error: z.ZodError): string {
  // A failed safeParse always carries at least one issue.
  const issue = error.issues[0]
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

/** The `data` payload a flight's coverage-mapping hand-off accepts on `submit` —
 *  the same `{ mappings, unmappable }` shape submit_external_coverage takes, so
 *  a client that knows the standalone tool answers the flight identically. */
export const mappingSubmissionInput = z.object({
  mappings: z.array(coverageMappingInput),
  unmappable: z.array(z.object({
    testName: z.string(),
    reason: z.string(),
  })).optional(),
})

export interface MappingSubmission {
  mappings: ProposedMapping[]
  /** Names only — the reasons are the client's audit prose, not an input the
   *  apply consumes (mirrors submitExternalCoverage's `unmappable` argument). */
  unmappable: string[]
}

export function parseMappingSubmission(
  data: unknown,
): { ok: true; submission: MappingSubmission } | { ok: false; error: string } {
  const parsed = mappingSubmissionInput.safeParse(data)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  return {
    ok: true,
    submission: {
      // Same widening the MCP tool performs on its schema-validated input.
      mappings: parsed.data.mappings as ProposedMapping[],
      unmappable: (parsed.data.unmappable ?? []).map((u) => u.testName),
    },
  }
}

/** Tests the answer left unaccounted for — the roster-completeness rule. Once
 *  the client owns its own fan-out, a test silently missing from the answer is
 *  indistinguishable from one read and found to have no requirement; the ledger
 *  would score it uncovered on silence rather than evidence, so completeness is
 *  checked against the roster the client was HANDED (pinned at hand-off time,
 *  never recomputed — a test added since is not the client's to answer for). */
export function missingFromRoster(
  roster: readonly string[],
  mappings: ReadonlyArray<{ testName: string }>,
  unmappable: readonly string[],
): string[] {
  const accounted = new Set<string>([...mappings.map((m) => m.testName), ...unmappable])
  return roster.filter((name) => !accounted.has(name))
}

/** Thrown when a submitted answer leaves some of the job's tests unaccounted for.
 *  Carries the names so the client can finish the job rather than guess. Lives
 *  beside the roster check so the standalone submit tool and the flight's
 *  re-park word the rejection identically. */
export class IncompleteCoverageAnswerError extends Error {
  constructor(public readonly missing: string[], total: number) {
    super(
      `answer accounts for ${total - missing.length} of ${total} tests — every test must appear in mappings[] `
      + `or unmappable[]. Missing: ${missing.slice(0, 10).join(', ')}`
      + `${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`,
    )
    this.name = 'IncompleteCoverageAnswerError'
  }
}
