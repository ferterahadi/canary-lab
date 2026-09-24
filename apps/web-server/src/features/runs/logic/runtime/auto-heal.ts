import fs from 'fs'
import path from 'path'
import { buildHealAddendum, type HealMode } from './heal-prompt-builder'
import { AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import { readManifest } from './manifest'
import { buildRunPaths } from './run-paths'
import { renderPersonalWikiMap } from '../../../../../../../shared/runtime/personal-wiki'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import {
  resolveAgentBinary,
  isAgentCliAvailable,
  candidateAgentPaths,
  type HealAgent,
  type AgentResolveDeps,
} from '../../../agent-sessions/logic/agent-binary'
import { directoryExists, renderPlaywrightMcpHint, renderTraceExtractHint } from './heal-prompt-map'

export { buildAgentSpawnCommand, buildClaudeMcpConfigArg, makeAgentSpawnCommandBuilder, pickAvailableHealAgent, readPriorSessionId, readPriorSessionIdFromValue } from './heal-agent-spawn'
export type { AgentSpawnArgs, AgentSpawnCommandDefaults } from './heal-agent-spawn'
export { buildHealPromptMap, renderPlaywrightMcpHint, renderTraceExtractHint } from './heal-prompt-map'
export type { HealPromptMap, HealPromptMapOptions, HealPromptResourceEntry, HealPromptStartEntry } from './heal-prompt-map'

// Agent-binary resolution moved to the spawn primitive's module so the runner
// can resolve a bare agent name itself; re-exported here for the orchestrator's
// REPL command builder and the long-standing import surface.
export { resolveAgentBinary, isAgentCliAvailable, candidateAgentPaths }

export type { HealAgent, AgentResolveDeps }

const HEAL_PROMPT_TEMPLATE_PATH = promptPath('heal-agent.md')

// Per-mode copy for the four placeholders in `prompts/heal-agent.md`.
//
// - `service`: a feature has editable repos in this run — the agent should
//   fix service/app code and avoid the test spec.
// - `test`: the run has zero editable repos (either `repos: []` in
//   feature.config.cjs, or every repo is env-gated off for this env). The
//   test spec / e2e helpers are the only fixable code, so we lift the "don't
//   read the test spec" prohibition and point the agent at it directly.
export const MODE_COPY: Record<HealMode, {
  healingDirective: string
  testSpecRule: string
  loggingRule: string
  closingDirective: string
}> = {
  service: {
    healingDirective: 'Fix service/app code, not tests.',
    testSpecRule: 'Do not read the test spec unless the failure cannot be understood from the index and logs.',
    loggingRule: "If the existing logs and snapshots don't give you a clear hypothesis, add temporary logging to the suspect service/app code and write the restart signal. The next cycle will read the new log output.",
    closingDirective: 'Make the failing Playwright tests pass on the next cycle by fixing the root cause in service/app code and writing the appropriate signal file.',
  },
  test: {
    healingDirective: 'This feature has no editable service repos. Fix the failing Playwright tests or their helpers.',
    testSpecRule: 'Read the failing test spec and its helpers (e.g., `e2e/helpers/`) — they are what you need to fix.',
    loggingRule: "If the logs and snapshots don't give you a clear hypothesis, add diagnostic logging or assertions in the test spec or helpers and write the rerun signal. The next cycle will pick up the new output.",
    closingDirective: 'Make the failing Playwright tests pass on the next cycle by fixing the test spec or its helpers and writing the rerun signal.',
  },
}

// Heal mode for the upcoming cycle. Determined from `manifest.repoPaths` on
// disk — empty (or unreadable) repoPaths means there are no editable services
// to fix, so the agent must fix the tests instead. On any read/parse error we
// default to `service` so a transient I/O glitch doesn't silently flip the
// prompt for a feature that does have editable repos.
export function detectHealMode(manifestPath: string): HealMode {
  const manifest = readManifest(manifestPath)
  if (!manifest) return 'service'
  const repoPaths = Array.isArray(manifest.repoPaths) ? manifest.repoPaths : []
  return repoPaths.length > 0 ? 'service' : 'test'
}

export interface OrchestratorAutoHealFactoryOptions {
  agent: HealAgent
  /** Project root used to render repo-relative run paths in the prompt. */
  projectRoot: string
  /** Per-run dir — the prompt file is written under <runDir>/heal-prompt.md. */
  runDir: string
  /** Optional local personal wiki folder for distilled cross-session context. */
  personalWikiPath?: string | null
  /** Override prompt template path resolution (tests). */
  promptPath?: string
  /** Cycle budget shown to the agent ("Cycle N of M"). Defaults to
   *  AUTO_HEAL_MAX_CYCLES — must match the orchestrator's actual cap. */
  maxCycles?: number
}

export interface BuildHealCyclePromptArgs {
  /** 1-based cycle number, shared with lifecycle events and the manifest. */
  cycle: number
  outputDir: string
  userGuidance?: string
  priorAgentSessionContext?: string
  /**
   * The current value of `HealCycleState.snapshot().consecutiveSameFailures`,
   * AFTER `observeFailures` has been called for this cycle. Threaded through
   * to `buildHealAddendum` so the stuck-cycle escalation block can fire at
   * the right moment (>= 3 = two prior fix attempts on the same set failed).
   */
  consecutiveSameFailures?: number
  /**
   * Flake-tolerant stuck set from `HealCycleState.stuckSlugs(ESCALATION_THRESHOLD)`
   * — currently failing tests that have failed >= threshold observations in a
   * row regardless of churn elsewhere in the set. Preferred escalation trigger.
   */
  stuckSlugs?: string[]
  /** `HealCycleState.snapshot().maxSlugStreak` — for escalation phrasing. */
  maxSlugStreak?: number
}

export type BuildHealCyclePrompt = (args: BuildHealCyclePromptArgs) => string

/**
 * Build a prompt-rendering function compatible with `AutoHealConfig.buildCyclePrompt`.
 * Returns the raw prompt text to write into the REPL's stdin — the orchestrator
 * pty.write()s it. The text is also persisted to `<runDir>/heal-prompt.md`
 * for debugging/forensics.
 */
export function buildOrchestratorHealPrompt(
  opts: OrchestratorAutoHealFactoryOptions,
): BuildHealCyclePrompt {
  // Eagerly load the packaged template so a missing asset surfaces at config
  // time, not on the first heal cycle.
  const promptTemplate = loadPromptTemplate(opts.promptPath ?? HEAL_PROMPT_TEMPLATE_PATH)
  const promptFile = path.join(opts.runDir, 'heal-prompt.md')
  const paths = buildRunPaths(opts.runDir)
  const runDirRel = path.relative(opts.projectRoot, opts.runDir) || opts.runDir

  return ({ cycle, userGuidance, priorAgentSessionContext, consecutiveSameFailures, stuckSlugs, maxSlugStreak }) => {
    // Re-detect per cycle: the manifest is written by the orchestrator before
    // the first heal cycle, and re-reading on each cycle keeps us correct if
    // a later iteration extends the manifest.
    const mode = detectHealMode(paths.manifestPath)
    const modeCopy = MODE_COPY[mode]
    const basePrompt = renderPromptTemplate(promptTemplate, {
      runDir: opts.runDir,
      runDirRel,
      healIndexPath: paths.healIndexPath,
      summaryPath: paths.summaryPath,
      failedDir: paths.failedDir,
      journalPath: paths.diagnosisJournalPath,
      featureDocsMap: renderFeatureDocsMap(paths.manifestPath),
      traceExtractHint: renderTraceExtractHint(paths.failedDir),
      playwrightMcpHint: renderPlaywrightMcpHint(paths.failedDir),
      restartSignal: paths.restartSignal,
      rerunSignal: paths.rerunSignal,
      personalWikiMap: renderPersonalWikiMap(opts.personalWikiPath),
      healingDirective: modeCopy.healingDirective,
      testSpecRule: modeCopy.testSpecRule,
      loggingRule: modeCopy.loggingRule,
      closingDirective: modeCopy.closingDirective,
    })
    const stateAddendum = buildHealAddendum({
      cycle,
      mode,
      summaryPath: paths.summaryPath,
      journalPath: paths.diagnosisJournalPath,
      // Plumb the stuck-cycle counters and per-run failedDir through so the
      // escalation block in `buildHealAddendum` can fire with concrete
      // `<failedDir>/<slug>/trace-extract/...` paths when the agent is stuck.
      consecutiveSameFailures,
      stuckSlugs,
      maxSlugStreak,
      failedDir: paths.failedDir,
      maxCycles: opts.maxCycles ?? AUTO_HEAL_MAX_CYCLES,
    })
    const guidance = userGuidance?.trim()
      ? `User guidance for this restarted heal cycle:\n\n${userGuidance.trim()}`
      : ''
    const priorContext = priorAgentSessionContext?.trim()
      ? `Previous agent session context from another agent:\n\n${priorAgentSessionContext.trim()}`
      : ''
    const fullPrompt = [basePrompt, stateAddendum, priorContext, guidance].filter(Boolean).join('\n\n')
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, fullPrompt)
    return fullPrompt
  }
}

function renderFeatureDocsMap(manifestPath: string): string {
  const docsDir = featureDocsDir(manifestPath)
  if (!docsDir) return ''
  return [
    'Feature context docs:',
    `- \`${docsDir}\` — uploaded Add Test documents and additional notes preserved for this feature. Read these when the failure may depend on product requirements, acceptance criteria, or user-provided context.`,
  ].join('\n')
}

export function featureDocsDir(manifestPath: string): string | null {
  const manifest = readManifest(manifestPath)
  const featureDir = manifest?.featureDir
  if (!featureDir) return null
  const docsDir = path.join(featureDir, 'docs')
  return directoryExists(docsDir) ? docsDir : null
}
