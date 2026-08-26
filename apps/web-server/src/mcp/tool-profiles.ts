import type { ClientKind } from '../../../../shared/run-mode'

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'author', 'coverage', 'export', 'flight', 'portify', 'lifecycle', 'full', 'compact'] as const

export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

// The default profile when a client connects without an explicit one (bare
// `canary-lab mcp` or a profile-less /mcp request). Setup-installed Desktop/CLI
// clients explicitly request `compact`; `lifecycle` is the lean end-to-end surface (repair +
// verify + author + coverage + export + flight) minus the STANDALONE portify
// management tools — starting a portify workflow from scratch, saving or
// cancelling one, removing a portification, listing status. Those stay opt-in
// via `--profile portify` (or `full`), keeping the common surface leaner.
//
// What lifecycle still carries is the legacy Portify hand-off trio (see
// FLIGHT_TOOLS), so an older persisted external workflow remains recoverable.
// New Flights keep final Parallel setup server-owned.
export const DEFAULT_CANARY_LAB_MCP_PROFILE: CanaryLabMcpProfile = 'lifecycle'

export type CanaryLabMcpToolName =
  | 'list_features'
  | 'list_runs'
  | 'get_run'
  | 'get_run_snapshot'
  | 'get_run_actions'
  | 'list_verification_configs'
  | 'get_verification_config'
  | 'create_verification_config'
  | 'update_verification_config'
  | 'execute_verification'
  | 'get_verification_result'
  | 'create_feature'
  | 'write_feature_doc'
  | 'delete_feature_doc'
  | 'get_feature_coverage'
  | 'list_feature_docs'
  | 'clear_prd_summary'
  | 'start_external_summary'
  | 'submit_external_summary'
  | 'start_external_coverage'
  | 'submit_external_coverage'
  | 'get_feature_envset_summary'
  | 'capture_feature_env_files'
  | 'write_envset'
  | 'delete_feature'
  | 'get_feature_repo_status'
  | 'checkout_feature_repo_branch'
  | 'start_external_evaluation_export'
  | 'submit_external_evaluation_export'
  | 'list_evaluation_exports'
  | 'get_evaluation_export'
  | 'download_evaluation_export'
  | 'delete_evaluation_export'
  | 'start_external_draft'
  | 'update_external_draft_stage'
  | 'apply_external_draft'
  | 'start_flight'
  | 'get_flight'
  | 'respond_flight_checkpoint'
  | 'pause_flight'
  | 'abort_flight'
  | 'stop_flight_agent'
  | 'get_heal_context'
  | 'get_failure_detail'
  | 'start_run'
  | 'boot_services'
  | 'pause_run'
  | 'cancel_heal'
  | 'abort_run'
  | 'claim_heal'
  | 'release_heal'
  | 'heartbeat'
  | 'wait_for_heal_task'
  | 'signal_run'
  | 'handoff_heal'
  | 'start_external_portify'
  | 'submit_external_portify'
  | 'revise_external_portify'
  | 'get_portify'
  | 'save_portify'
  | 'cancel_portify'
  | 'remove_portification'
  | 'list_portify_status'

export const EXEC_TOOL_NAME = 'exec' as const
export type CanaryLabMcpExposedToolName = CanaryLabMcpToolName | typeof EXEC_TOOL_NAME
export type CanaryLabMcpExecCommand =
  | CanaryLabMcpToolName
  | 'list_tools'
  | 'search_tools'
  | 'describe_tool'
  | 'unknown'

export interface CanaryLabMcpExecCallEvent {
  command: CanaryLabMcpExecCommand
  durationMs: number
  success: boolean
  validationError?: boolean
}

export const REPAIR_TOOLS = [
  'list_features',
  'list_runs',
  'start_run',
  'boot_services',
  'wait_for_heal_task',
  'get_heal_context',
  'get_failure_detail',
  'get_run_snapshot',
  'get_run',
  'signal_run',
  'heartbeat',
  'pause_run',
  'cancel_heal',
  'abort_run',
  'handoff_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

export const VERIFY_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'boot_services',
  'abort_run',
  'list_verification_configs',
  'get_verification_config',
  'create_verification_config',
  'update_verification_config',
  'execute_verification',
  'get_verification_result',
] as const satisfies readonly CanaryLabMcpToolName[]

// Author = create/extend a feature, write specs, capture envsets, manage the
// feature's repos. Docs/PRD/coverage live in `coverage`, evaluation archives in
// `export`, and the conducted pipeline in `flight` — all four used to be one
// array; the split keeps each skill/client surface lean while `lifecycle`/`full`
// stay the same computed unions.
export const AUTHOR_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'get_run_snapshot',
  'create_feature',
  'get_feature_envset_summary',
  'capture_feature_env_files',
  'write_envset',
  'delete_feature',
  'get_feature_repo_status',
  'checkout_feature_repo_branch',
  // Read-only views of the coverage ledger and its source docs. Authoring "a
  // test for the missing behavior" starts from the gap, and without these the
  // narrowest profile that can write a spec cannot see which requirement is
  // untested — the Getting Started "Author Tests" demo dead-ended exactly
  // there. Writing docs/summaries/mappings stays in COVERAGE_TOOLS.
  'get_feature_coverage',
  'list_feature_docs',
  'start_external_draft',
  'update_external_draft_stage',
  'apply_external_draft',
] as const satisfies readonly CanaryLabMcpToolName[]

// Coverage = feature docs → PRD summary → semantic coverage ledger (carved out
// of the old author array; the tools are unchanged).
export const COVERAGE_TOOLS = [
  'list_features',
  'write_feature_doc',
  'delete_feature_doc',
  'list_feature_docs',
  'clear_prd_summary',
  'start_external_summary',
  'submit_external_summary',
  'start_external_coverage',
  'submit_external_coverage',
  'get_feature_coverage',
] as const satisfies readonly CanaryLabMcpToolName[]

// Export = evaluation archives for a terminal run (carved out of the old
// author array). list_runs/get_run ride along to pick the run to export.
export const EXPORT_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'start_external_evaluation_export',
  'submit_external_evaluation_export',
  'list_evaluation_exports',
  'get_evaluation_export',
  'download_evaluation_export',
  'delete_evaluation_export',
] as const satisfies readonly CanaryLabMcpToolName[]

// Flight = the conducted end-to-end pipeline. write_feature_doc rides along so
// the client can distill conversation docs at the prd-source checkpoint.
export const FLIGHT_TOOLS = [
  // Every shipped skill's bootstrap uses list_features as its liveness probe
  // ("only an unknown-tool error means the server is disconnected") — flight
  // was the one profile where that probe itself errored, misreporting a
  // healthy server as disconnected.
  'list_features',
  'start_flight',
  'get_flight',
  'respond_flight_checkpoint',
  // Stopping is part of driving. Without these, an MCP client could start a
  // flight and answer its checkpoints but never stop one — the promise lived
  // only in the web UI's Pause button, so an agent's only way out was to stop
  // polling and leave the pipeline running.
  'pause_flight',
  'abort_flight',
  // Narrower than abort: stops the stage's agent and leaves the run/export up.
  'stop_flight_agent',
  'write_feature_doc',
  // Legacy compatibility: Flights persisted before final Parallel setup became
  // server-owned may still hold an external Portify hand-off. Current clients
  // release it with `run-internally`; keeping the read/submit/revise trio here
  // also lets an older connected client settle that persisted engagement.
  //
  // Exactly three, and the omissions are deliberate: `start_external_portify` is
  // the flight's own job (the client is handed a live `workflowId`), and
  // `save_portify`/`cancel_portify` are the decision the flight OWNS — it
  // re-checks the workflow and the overlay mark itself, and the hand-off prose
  // tells the client never to call them. Handing a client a tool it is
  // instructed not to use is worse than withholding it.
  'submit_external_portify',
  'revise_external_portify',
  'get_portify',
  // The run/heal hand-off, for the same reason. An external flight starts the run
  // UNCLAIMED and parks: the client claims heal with its own session id, loops
  // wait_for_heal_task, fixes APP code, and signals after each fix. These three
  // are that loop. They already reach `lifecycle` via REPAIR_TOOLS +
  // FULL_ONLY_TOOLS, so this union is unchanged — but `flight` is the NARROWEST
  // profile that can call start_flight, and it could not answer its own hand-off.
  // Found by flight-handoff-tools.test.ts on the commit that added the portify
  // trio above, which is exactly what that test is for.
  'claim_heal',
  'wait_for_heal_task',
  'signal_run',
] as const satisfies readonly CanaryLabMcpToolName[]

// Portify DRIVEN STANDALONE — start a workflow from scratch, save or cancel it,
// remove a portification, list status. It keeps its own profile so the everyday
// surface stays lean; clients that manage portification directly connect with
// profile=portify (or full). The three tools a FLIGHT's portify hand-off needs
// live in FLIGHT_TOOLS as well, so they reach lifecycle through that union.
export const PORTIFY_TOOLS = [
  'list_features',
  'list_runs',
  'start_external_portify',
  'submit_external_portify',
  'revise_external_portify',
  'get_portify',
  'save_portify',
  'cancel_portify',
  'remove_portification',
  'list_portify_status',
] as const satisfies readonly CanaryLabMcpToolName[]

// Tools that exist only in the `full`/`lifecycle` profiles — everything else is
// composed from the per-workflow profiles above.
export const FULL_ONLY_TOOLS = [
  'get_run_actions',
  'claim_heal',
  'release_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

// `lifecycle` is the end-to-end authoring → run → heal → verify → export surface
// plus the flight pipeline — the everyday one-session profile. It reaches the
// legacy Portify hand-off trio through FLIGHT_TOOLS; `full` adds the standalone portify
// management tools on top. Both are deduplicated unions, so adding a tool to any workflow array
// surfaces it automatically — no second edit, no drift, no duplicate entries.
export const LIFECYCLE_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...REPAIR_TOOLS,
    ...VERIFY_TOOLS,
    ...AUTHOR_TOOLS,
    ...COVERAGE_TOOLS,
    ...EXPORT_TOOLS,
    ...FLIGHT_TOOLS,
    ...FULL_ONLY_TOOLS,
  ]),
)

export const FULL_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...LIFECYCLE_TOOLS,
    ...PORTIFY_TOOLS,
  ]),
)

export const COMPACT_TOOLS = [EXEC_TOOL_NAME] as const satisfies readonly CanaryLabMcpExposedToolName[]

export const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpExposedToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  author: AUTHOR_TOOLS,
  coverage: COVERAGE_TOOLS,
  export: EXPORT_TOOLS,
  flight: FLIGHT_TOOLS,
  portify: PORTIFY_TOOLS,
  lifecycle: LIFECYCLE_TOOLS,
  full: FULL_TOOLS,
  compact: COMPACT_TOOLS,
}

export function isCanaryLabMcpProfile(value: string | undefined): value is CanaryLabMcpProfile {
  return !!value && (CANARY_LAB_MCP_PROFILES as readonly string[]).includes(value)
}

export function normalizeCanaryLabMcpProfile(value: string | undefined): CanaryLabMcpProfile | null {
  if (!value) return DEFAULT_CANARY_LAB_MCP_PROFILE
  return isCanaryLabMcpProfile(value) ? value : null
}

export function toolsForCanaryLabMcpProfile(profile: CanaryLabMcpProfile): readonly CanaryLabMcpExposedToolName[] {
  return TOOLS_BY_PROFILE[profile]
}

export interface CanaryLabMcpToolOptions {
  profile?: CanaryLabMcpProfile
  /** The connect URL's explicit client_kind. Leave unset when the URL carried
   *  none — tool calls then brand themselves from the initialize handshake
   *  (clientKindFromFacts), which never yields a claim-suppressing *-pty kind. */
  defaultClientKind?: ClientKind
  /** Compact-profile telemetry records only the selected command and outcome;
   *  argument values never leave the dispatcher. */
  onExecCall?: (event: CanaryLabMcpExecCallEvent) => void
}
