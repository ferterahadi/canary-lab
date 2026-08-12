import type { ClientKind } from '../../../../shared/run-mode'

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'author', 'coverage', 'export', 'flight', 'portify', 'lifecycle', 'full'] as const

export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

// The default profile when a client connects without an explicit one (bare
// `canary-lab mcp`, the registered Desktop/CLI invocation, a profile-less
// /mcp request). `lifecycle` is the everyday end-to-end surface (repair +
// verify + author + coverage + export + flight) MINUS portify — the
// specialized, infrequent port-injection workflow. Portify clients opt in
// with `--profile portify` (or `full`), keeping the common surface leaner in
// tools + instructions.
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
] as const satisfies readonly CanaryLabMcpToolName[]

// Portify is a specialized, infrequent operation (make a feature's ports
// injectable so it can boot concurrently). It lives in its own profile so the
// everyday authoring/lifecycle surface stays lean; clients that need it connect
// with profile=portify (or full).
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
// MINUS portify — the everyday one-session profile. `full` is `lifecycle` plus
// portify. Both are deduplicated unions, so adding a tool to any workflow array
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

export const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  author: AUTHOR_TOOLS,
  coverage: COVERAGE_TOOLS,
  export: EXPORT_TOOLS,
  flight: FLIGHT_TOOLS,
  portify: PORTIFY_TOOLS,
  lifecycle: LIFECYCLE_TOOLS,
  full: FULL_TOOLS,
}

export function isCanaryLabMcpProfile(value: string | undefined): value is CanaryLabMcpProfile {
  return !!value && (CANARY_LAB_MCP_PROFILES as readonly string[]).includes(value)
}

export function normalizeCanaryLabMcpProfile(value: string | undefined): CanaryLabMcpProfile | null {
  if (!value) return DEFAULT_CANARY_LAB_MCP_PROFILE
  return isCanaryLabMcpProfile(value) ? value : null
}

export function toolsForCanaryLabMcpProfile(profile: CanaryLabMcpProfile): readonly CanaryLabMcpToolName[] {
  return TOOLS_BY_PROFILE[profile]
}

export interface CanaryLabMcpToolOptions {
  profile?: CanaryLabMcpProfile
  defaultClientKind?: ClientKind
}
