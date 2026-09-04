import { loadPromptTemplate, promptPath } from '../shared/prompts'
import type { CanaryLabMcpProfile } from './tool-profiles'

// What the Claude Code CLI keeps of a server's `instructions`: its logs read
// "Server instructions truncated from N to 2048 chars", and everything past the
// cut is silently dropped (in 2.1.x the cut is applied in the client, so no
// server-side setting can widen it). Every profile's initialize text must
// therefore fit inside this window, and the rest of a workflow's guidance is
// delivered on demand by the `get_workflow_guide` tool — tool descriptions and
// tool results are not truncated. Pinned by instructions.test.ts.
export const INSTRUCTIONS_DELIVERED_WINDOW = 2048

export const CANARY_LAB_MCP_WORKFLOWS = ['repair', 'verify', 'author', 'coverage', 'flight', 'export', 'portify'] as const
export type CanaryLabMcpWorkflow = typeof CANARY_LAB_MCP_WORKFLOWS[number]

/**
 * A prompt file may carry this line once. Everything above it is the profile's
 * initialize lead (what a skill-less client reads at `initialize`); the guide
 * keeps the whole file minus the marker, so the lead never has to be repeated
 * below the cut. A file without the marker delivers all of its text both ways.
 */
export const INITIALIZE_CUT_MARKER = '<!-- initialize-cut -->'

export interface InstructionSplit {
  lead: string
  guide: string
}

export function splitAtInitializeCut(text: string, source: string): InstructionSplit {
  const lines = text.split('\n')
  const cuts = lines.flatMap((line, index) => (line.trim() === INITIALIZE_CUT_MARKER ? [index] : []))
  if (cuts.length === 0) return { lead: text, guide: text }
  if (cuts.length > 1) {
    throw new Error(`${source}: expected one ${INITIALIZE_CUT_MARKER} line, found ${cuts.length}`)
  }
  const at = cuts[0]!
  return {
    lead: lines.slice(0, at).join('\n').trim(),
    guide: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').trim(),
  }
}

function loadWorkflow(workflow: CanaryLabMcpWorkflow): InstructionSplit {
  const name = `mcp-${workflow}-instructions.md`
  return splitAtInitializeCut(loadPromptTemplate(promptPath(name)), name)
}

const WORKFLOW_INSTRUCTIONS = Object.fromEntries(
  CANARY_LAB_MCP_WORKFLOWS.map((workflow) => [workflow, loadWorkflow(workflow)]),
) as Record<CanaryLabMcpWorkflow, InstructionSplit>

/** The complete guide per workflow — what `get_workflow_guide` returns. */
export const WORKFLOW_GUIDES: Record<CanaryLabMcpWorkflow, string> = Object.fromEntries(
  CANARY_LAB_MCP_WORKFLOWS.map((workflow) => [workflow, WORKFLOW_INSTRUCTIONS[workflow].guide]),
) as Record<CanaryLabMcpWorkflow, string>

// `lifecycle` and `full` expose several workflows on one connection, so their
// initialize text is an index — one line per workflow plus the rules that hold
// everywhere — rather than the concatenation of every lead (which would put all
// but the first workflow past the cut). `full` only adds the standalone portify
// tools, and the index already points at that guide, so both share one file.
const LIFECYCLE_INSTRUCTIONS = loadPromptTemplate(promptPath('mcp-lifecycle-instructions.md'))

const COMPACT_INSTRUCTIONS = loadPromptTemplate(promptPath('mcp-compact-instructions.md'))

// Sent to MCP clients through initialize/discovery so external agents that do
// not carry the Canary Lab skill still learn the run/heal/author loops. The
// repair text is load-bearing: without it, result-driven clients invent their
// own get_run_snapshot poll loop instead of blocking on wait_for_heal_task,
// and never pick up the needs_heal handoff. Exported so
// `repair-guardrail.test.ts` can pin the repair rule on every profile that can
// drive a heal loop.
export const INSTRUCTIONS_BY_PROFILE: Record<CanaryLabMcpProfile, string> = {
  repair: WORKFLOW_INSTRUCTIONS.repair.lead,
  verify: WORKFLOW_INSTRUCTIONS.verify.lead,
  author: WORKFLOW_INSTRUCTIONS.author.lead,
  coverage: WORKFLOW_INSTRUCTIONS.coverage.lead,
  export: WORKFLOW_INSTRUCTIONS.export.lead,
  flight: WORKFLOW_INSTRUCTIONS.flight.lead,
  portify: WORKFLOW_INSTRUCTIONS.portify.lead,
  lifecycle: LIFECYCLE_INSTRUCTIONS,
  full: LIFECYCLE_INSTRUCTIONS,
  compact: COMPACT_INSTRUCTIONS,
}
