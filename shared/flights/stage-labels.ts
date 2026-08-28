import type { FlightStageKey } from './types'

/** Stage key → what the stage does for the user (outcome, not implementation).
 *  ONE home for both sides: the web rail/launcher/menus render these, and the
 *  server interpolates them into user-facing messages (stage-entry rejections)
 *  instead of leaking raw stage keys like `specs-coverage` into the GUI.
 *  Stage KEYS stay canonical in the store/MCP/CLI — only display copy lives
 *  here. Sentence case throughout: these read inline ("Waiting for Test run.",
 *  "start from Suite setup"), where Title Case reads as a different register. */
export const FLIGHT_STAGE_LABEL: Record<FlightStageKey, string> = {
  'similarity': 'Existing suite found',
  'scout': 'Repo scan',
  'scaffold': 'Suite setup',
  'env-capture': 'Settings snapshot',
  'docs': 'Doc collection',
  'prd-summary': 'Requirements summary',
  'specs-coverage': 'Tests & coverage',
  'portify': 'Parallel setup',
  'run': 'Test run',
  'heal': 'Auto-repair',
  'evaluation-export': 'Report',
}

/** The rail folds implementation stages into user-visible steps. Keep the
 * restart menu on this same vocabulary so its labels cannot drift. */
export const FLIGHT_RAIL_LABEL: Partial<Record<FlightStageKey, string>> = {
  'scaffold': 'Suite setup',
  'docs': 'Requirements',
}

export function flightRailLabel(key: FlightStageKey): string {
  return FLIGHT_RAIL_LABEL[key] ?? flightStageLabel(key)
}

export function flightStageLabel(key: string): string {
  return (FLIGHT_STAGE_LABEL as Record<string, string>)[key] ?? key
}
