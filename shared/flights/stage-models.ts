import { MODEL_STAGE_LABEL, stageChoiceValue, type AgentStagePlans, type ModelStageKey } from '../agent-models'
import type { FlightStageKey } from './types'

/** Which internal agent spawns a rail ROW is answerable for, keyed by the row's
 *  primary stage — so a merged pair carries its companion's spawns too (Test
 *  run folds heal, Requirements folds prd-summary). The model-cockpit keys are
 *  their own vocabulary: `gen` and `mapping` are the authoring and annotate
 *  passes of specs-coverage, and `commit` is the message the run writes when it
 *  opens a PR (see run-model-plan). A row that spawns no agent — Suite setup,
 *  Settings snapshot, the similarity pre-check — is absent on purpose: no model
 *  runs there, so no model can be reported there. */
export const FLIGHT_ROW_MODEL_STAGES: Partial<Record<FlightStageKey, readonly ModelStageKey[]>> = {
  'scout': ['scout'],
  'docs': ['docs', 'prd'],
  'specs-coverage': ['gen', 'mapping'],
  'run': ['heal', 'commit'],
  'portify': ['portify'],
  'evaluation-export': ['report'],
}

/** One model chip on a stage: the knobs, and the sentence naming the spawns
 *  they belong to. */
export interface StageModelChip {
  /** The first contributing model stage — a stable key for the rendered chip. */
  stage: ModelStageKey
  /** Which spawn the model is FOR, joined with `+` when a collapsed chip
   *  answers for both. A bare `opus · high` told the reader a model was pinned
   *  but not to what — the chip carries its own subject rather than parking it
   *  in a hover only a mouse can reach. */
  label: string
  value: string
  title: string
}

/** The pinned model choices to show ON a rail row, in spawn order. Spawns that
 *  share the same knobs collapse into ONE chip naming both: a row whose two
 *  agents run identically is one fact, not the same fact twice. */
export function flightRowModelChips(
  row: FlightStageKey,
  plans: AgentStagePlans | undefined,
): StageModelChip[] {
  const groups: Array<{ stage: ModelStageKey; value: string; labels: string[] }> = []
  for (const stage of FLIGHT_ROW_MODEL_STAGES[row] ?? []) {
    const value = stageChoiceValue(plans?.[stage])
    if (!value) continue
    const group = groups.find((g) => g.value === value)
    if (group) group.labels.push(MODEL_STAGE_LABEL[stage])
    else groups.push({ stage, value, labels: [MODEL_STAGE_LABEL[stage]] })
  }
  return groups.map(({ stage, value, labels }) => ({
    stage,
    // `+` on the chip, `and` in the sentence: the chip is a compact pairing,
    // the tooltip a sentence.
    label: labels.join(' + '),
    value,
    // "locked when this flight started" is the same caveat the strip carried:
    // this is the plan the record pinned, not a claim about what already ran.
    title: `${labels.join(' and ')} ${labels.length === 1 ? 'runs' : 'run'} on ${value} — locked when this flight started`,
  }))
}
