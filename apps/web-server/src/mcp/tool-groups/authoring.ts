// MCP tools — external authoring and export control.
//
// This module is the group's composer: every tool body lives in one of the
// sibling authoring-*/flight/portify modules, and `registerAuthoringTools` is
// the single entry point ../tools.ts still calls. Add a tool to the sibling for
// its domain, then wire its name into the profile arrays in ../tool-support.ts
// (see the cl_add-mcp-tool skill).
import type { ToolGroupContext } from '../tool-support'
import { registerCoverageAuthoringTools } from './authoring-coverage'
import { registerExternalDraftTools } from './authoring-drafts'
import { registerFeatureEnvTools } from './authoring-env'
import { registerEvaluationExportTools } from './authoring-export'
import { registerFeatureAuthoringTools } from './authoring-features'
import { registerFlightTools } from './flight'
import { registerPortifyTools } from './portify'

export function registerAuthoringTools(ctx: ToolGroupContext): void {
  registerFeatureAuthoringTools(ctx)
  registerCoverageAuthoringTools(ctx)
  registerFeatureEnvTools(ctx)
  registerEvaluationExportTools(ctx)
  registerExternalDraftTools(ctx)
  registerFlightTools(ctx)
  registerPortifyTools(ctx)
}
