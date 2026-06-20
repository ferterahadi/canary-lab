import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { buildHealAddendum, type HealMode } from './heal-prompt-builder'
import { readManifest } from './manifest'
import { buildRunPaths } from './run-paths'
import { renderPersonalWikiMap } from '../../../../../../../shared/runtime/personal-wiki'
import { HEAL_MODELS } from '../../../agent-sessions/logic/agent-models'

// Heal-agent command builders for the web-server orchestrator. The orchestrator
// runs claude / codex as a long-lived interactive REPL (no `-p`, no formatter
// pipe). The shell command produced here is just the binary + flags — the
// per-cycle prompt is written to the pty's stdin by `RunOrchestrator` after
// spawn, which lets users type into the same session for smooth interjects.

export type HealAgent = 'claude' | 'codex'

// Injectable seams for agent-binary resolution. Production uses real `which`
// + fs probing; tests inject deterministic stubs.
export interface AgentResolveDeps {
  which?: (agent: string) => string | null
  isExecutable?: (filePath: string) => boolean
  env?: NodeJS.ProcessEnv
  homedir?: () => string
}

function defaultWhich(agent: string): string | null {
  try {
    // `which` exits non-zero (→ throws) when nothing is found, so a clean
    // return always carries a path. An empty result is treated as not-found
    // by the caller (falsy), so no extra guard is needed here.
    const out = execFileSync('which', [agent], { encoding: 'utf-8' }).trim()
    return out.split('\n')[0].trim()
  } catch {
    return null
  }
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// nvm installs CLIs under ~/.nvm/versions/node/<ver>/bin. Best-effort scan so
// a Node-installed `codex`/`claude` is found even when the active nvm version
// isn't on the server's PATH.
function nodeVersionBinDirs(homedir: string): string[] {
  const base = path.join(homedir, '.nvm', 'versions', 'node')
  try {
    return fs.readdirSync(base).map((ver) => path.join(base, ver, 'bin'))
  } catch {
    return []
  }
}

// Well-known install locations probed when the agent isn't on the server's
// PATH. This is the crux of the restricted-PATH fix: when the UI server is
// launched by a GUI client (e.g. Claude Desktop) its PATH is minimal and omits
// ~/.local/bin etc., so a bare `which claude` fails even though claude is
// installed. We probe the usual homes so local auto-heal still spawns.
export function candidateAgentPaths(
  agent: HealAgent,
  homedir: string,
): string[] {
  const dirs = [
    path.join(homedir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(homedir, '.npm-global', 'bin'),
    path.join(homedir, 'Library', 'pnpm'),
    ...nodeVersionBinDirs(homedir),
  ]
  return dirs.map((dir) => path.join(dir, agent))
}

// Resolve the absolute path of a heal-agent CLI, or null when not found.
// Order: explicit env override → PATH (`which`) → well-known locations.
export function resolveAgentBinary(agent: HealAgent, deps: AgentResolveDeps = {}): string | null {
  const which = deps.which ?? defaultWhich
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const env = deps.env ?? process.env
  const homedir = deps.homedir ? deps.homedir() : os.homedir()

  const override = agent === 'claude' ? env.CANARY_LAB_CLAUDE_BIN : env.CANARY_LAB_CODEX_BIN
  if (override && isExecutable(override)) return override

  const onPath = which(agent)
  if (onPath) return onPath

  for (const candidate of candidateAgentPaths(agent, homedir)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function isAgentCliAvailable(agent: HealAgent, deps: AgentResolveDeps = {}): boolean {
  return resolveAgentBinary(agent, deps) !== null
}

// Standard UUID format (any version). Matches what `randomUUID()` and
// claude's session id format produce. Anchored so partial garbage in the
// file is rejected as invalid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readPriorSessionIdFromValue(value: string): string | null {
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : null
}

/**
 * Read a previously-persisted agent session UUID from disk. Returns the
 * trimmed UUID when the file exists and contains a single valid UUID;
 * returns null when the file is missing, unreadable, empty, or contains
 * anything that doesn't look like a UUID.
 *
 * Used by `spawnHealAgentRepl` to resume the prior conversation on
 * Restart Heal instead of starting a fresh one with a new id.
 */
export function readPriorSessionId(sessionIdPath: string): string | null {
  let raw: string
  try { raw = fs.readFileSync(sessionIdPath, 'utf-8') } catch { return null }
  return readPriorSessionIdFromValue(raw)
}

const HEAL_PROMPT_TEMPLATE_PATH = path.join(__dirname, '../../../../../prompts/heal-agent.md')

// Per-mode copy for the four placeholders in `prompts/heal-agent.md`.
//
// - `service`: a feature has editable repos in this run — the agent should
//   fix service/app code and avoid the test spec.
// - `test`: the run has zero editable repos (either `repos: []` in
//   feature.config.cjs, or every repo is env-gated off for this env). The
//   test spec / e2e helpers are the only fixable code, so we lift the "don't
//   read the test spec" prohibition and point the agent at it directly.
const MODE_COPY: Record<HealMode, {
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

function loadPromptTemplate(promptPath: string = HEAL_PROMPT_TEMPLATE_PATH): string {
  if (!fs.existsSync(promptPath)) {
    throw new Error(
      `Heal prompt template not found at ${promptPath}. Rebuild or reinstall canary-lab.`,
    )
  }
  return fs.readFileSync(promptPath, 'utf-8').trim()
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  // Drop any line that holds nothing but a single placeholder that resolves
  // to empty — otherwise the empty bullet sits between live bullets and
  // breaks the markdown list. Lines that mix a placeholder with other text
  // (e.g. `- {{failedDir}}/<slug>/foo`) are left alone.
  const placeholderOnlyLine = /^[ \t]*\{\{(\w+)\}\}[ \t]*$/
  const lines = template.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const m = line.match(placeholderOnlyLine)
    if (m && (values[m[1]] ?? '').length === 0) continue
    kept.push(line.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match))
  }
  return kept.join('\n')
}

// Build a transient `--mcp-config` argument for `claude`. Writes the MCP
// servers JSON (registering `@playwright/mcp` with `--output-dir <outputDir>`
// so the agent's browser snapshots land in the per-failure dir) to
// `configFilePath`, and returns `--mcp-config "<configFilePath>"`.
//
// Why a file and not inline JSON: current `claude` versions try to `open()`
// the value as a path before falling back to JSON parsing. A multi-hundred-
// byte JSON literal trips ENAMETOOLONG (PATH_MAX is ~1024 on macOS) and the
// agent never starts. A file path always works.
export function buildClaudeMcpConfigArg(outputDir: string, configFilePath: string): string {
  const cfg = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--output-dir', outputDir],
      },
    },
  }
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true })
  fs.writeFileSync(configFilePath, JSON.stringify(cfg, null, 2))
  return `--mcp-config ${JSON.stringify(configFilePath)}`
}

export interface AgentSpawnArgs {
  /** Pin claude's session UUID. Lets the orchestrator know the id without
   *  parsing init frames. For codex this is used only with `resume: true`,
   *  after the orchestrator has discovered and persisted the prior session id. */
  sessionId?: string
  /** Resume an existing claude conversation by `sessionId` instead of pinning
   *  a fresh one. When true with a `sessionId`, the spawn command emits
   *  `--resume <uuid>` (continues the prior conversation with history). When
   *  false (default), emits `--session-id <uuid>` (starts a new conversation
   *  pinned to that id). For codex, true with a `sessionId` emits
   *  `codex resume <uuid>`. */
  resume?: boolean
  /** Where Playwright MCP should write artifacts. When set, claude is spawned
   *  with `--mcp-config` pointing at a JSON file we write to `mcpConfigFile`
   *  describing the playwright server with `--output-dir <mcpOutputDir>`.
   *  When omitted, no `--mcp-config` flag is added. */
  mcpOutputDir?: string
  /** Path the MCP config JSON should be written to. Required when
   *  `mcpOutputDir` is set. Conventionally `<runDir>/mcp-config.json`. */
  mcpConfigFile?: string
  /** Path to the cycle-1 heal prompt. When set, the spawn command appends
   *  `"@<promptFile>"` as a positional argument so claude reads the file
   *  and processes its content as the first user message — bypassing the
   *  REPL's input editor entirely. The orchestrator writes the prompt
   *  body to this path BEFORE spawning. */
  promptFile?: string
  /** Absolute path to the agent binary, from `resolveAgentBinary`. When set,
   *  the command launches via this quoted path instead of the bare `claude`/
   *  `codex` name — so the heal agent spawns even when the server's PATH is
   *  restricted (e.g. a Desktop-launched UI server). Omitted in unit tests,
   *  which keep asserting against the bare command name. */
  binaryPath?: string
}

/**
 * Build the spawn command for a long-lived REPL. Returns just the binary +
 * flags — the orchestrator writes the per-cycle prompt to the pty's stdin
 * after spawn, so this command does not include any `-p`/positional prompt.
 *
 * Permissions are intentionally NOT bypassed here. With the headless `-p`
 * flow we passed `--dangerously-skip-permissions` (resp. codex `--full-auto`)
 * because there was no human to approve tool calls. In REPL mode the user
 * is right there in the pane and can approve / deny each tool — bypassing
 * also hides MCP auth prompts the user needs to see.
 *
 * Claude session flag:
 * - `--session-id <uuid>`: starts a NEW conversation pinned to that uuid.
 *   Used on first spawn for a run so the orchestrator knows the id without
 *   parsing init frames.
 * - `--resume <uuid>`: resumes an EXISTING conversation by uuid. Used when
 *   restarting heal on a previously-failed run so the agent keeps its prior
 *   investigation history.
 *
 * - claude: `claude [--resume <uuid> | --session-id <uuid>] [--mcp-config <path>]`
 * - codex:  `codex` or `codex resume <uuid>`
 */
export function buildAgentSpawnCommand(agent: HealAgent, args: AgentSpawnArgs = {}): string {
  // Positional `@<promptFile>` arg — claude reads the file at startup and
  // processes its content as the first user message. This sidesteps the
  // REPL's input editor entirely, which doesn't reliably submit multi-line
  // content sent via stdin paste. Writing the prompt body to disk first is
  // the orchestrator's responsibility.
  //
  // CRITICAL: the standalone `--` separator before the positional. Without
  // it, claude's variadic `--mcp-config <configs...>` would greedily slurp
  // the positional as another config file path (the file then doesn't
  // exist as JSON, claude reports `MCP config file not found`, and the
  // REPL exits before processing any prompt). `--` is the POSIX
  // end-of-options marker — commander.js (claude / codex's argv parser)
  // honors it.
  const promptArg = args.promptFile ? ` -- ${JSON.stringify(`@${args.promptFile}`)}` : ''

  // The command head: an absolute, quoted binary path when resolved (works
  // under a restricted PATH), otherwise the bare agent name (PATH lookup).
  const head = args.binaryPath ? JSON.stringify(args.binaryPath) : agent

  // Optional `--model` — placed right after the binary so it reads as a global
  // flag for both claude and codex (before codex's `resume` subcommand). Empty
  // string when the feature runs on the agent default (HEAL_MODELS).
  const model = HEAL_MODELS[agent]
  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : ''

  if (agent === 'claude') {
    const sid = args.sessionId
      ? (args.resume
        ? ` --resume ${JSON.stringify(args.sessionId)}`
        : ` --session-id ${JSON.stringify(args.sessionId)}`)
      : ''
    let mcp = ''
    if (args.mcpOutputDir) {
      if (!args.mcpConfigFile) {
        throw new Error('buildAgentSpawnCommand: mcpConfigFile is required when mcpOutputDir is set')
      }
      mcp = ` ${buildClaudeMcpConfigArg(args.mcpOutputDir, args.mcpConfigFile)}`
    }
    // No `--dangerously-skip-permissions` — REPL hands tool approval back
    // to the user.
    return `${head}${modelFlag}${sid}${mcp}${promptArg}`
  }
  // codex interactive REPL. No `--full-auto`: tool approvals stay
  // interactive in the pane. Codex has no `--session-id` analogue, so the
  // first run starts normally. Once the orchestrator discovers Codex's
  // persisted session id, Restart Heal can use `codex resume <id>`.
  if (args.resume && args.sessionId) {
    return `${head}${modelFlag} resume ${JSON.stringify(args.sessionId)}${promptArg}`
  }
  // Codex accepts a positional prompt the same way as claude.
  return `${head}${modelFlag}${promptArg}`
}

/**
 * Pick which agent CLI to use for healing in the web orchestrator.
 *
 * - When `envOverride` is `'claude'` or `'codex'`, that exact agent is
 *   required — returns null when its CLI isn't on PATH.
 * - When `envOverride` is set to anything else (typo guard), returns null.
 * - When `envOverride` is unset, auto-detects: prefers claude when present,
 *   falls back to codex, returns null when neither is on PATH.
 */
export function pickAvailableHealAgent(
  envOverride: string | undefined = process.env.CANARY_LAB_HEAL_AGENT,
  deps: AgentResolveDeps = {},
): HealAgent | null {
  if (envOverride === 'claude' || envOverride === 'codex') {
    return isAgentCliAvailable(envOverride, deps) ? envOverride : null
  }
  if (envOverride !== undefined && envOverride !== '') {
    // Set but unrecognised — refuse to silently fall through, so a typoed
    // value like `clauude` doesn't pretend to work.
    return null
  }
  if (isAgentCliAvailable('claude', deps)) return 'claude'
  if (isAgentCliAvailable('codex', deps)) return 'codex'
  return null
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
}

export interface BuildHealCyclePromptArgs {
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
}

export type BuildHealCyclePrompt = (args: BuildHealCyclePromptArgs) => string

export interface HealPromptStartEntry {
  id: 'heal-index' | 'summary'
  field?: 'healIndexMarkdown' | 'summary'
  path: string
  purpose: string
}

export interface HealPromptResourceEntry {
  id:
    | 'failed-slices'
    | 'trace-extract'
    | 'playwright-mcp'
    | 'full-service-log'
    | 'journal'
    | 'feature-docs'
    | 'personal-wiki'
  field?: 'journalMarkdown'
  path: string
  useWhen: string
}

export interface HealPromptMap {
  source: 'canary-lab/heal-agent-map'
  mode: HealMode
  runDir: string
  runDirRel: string
  startHere: HealPromptStartEntry[]
  resources: HealPromptResourceEntry[]
  boundaries: {
    fixTarget: string
    signalPolicy: {
      serviceOrRuntimeChange: 'restart'
      testOrConfigOnlyChange: 'rerun'
      mechanism: 'call signal_run; do not write signal files directly'
    }
  }
}

export interface HealPromptMapOptions {
  projectRoot: string
  runDir: string
  personalWikiPath?: string | null
}

export function buildHealPromptMap(opts: HealPromptMapOptions): HealPromptMap {
  const paths = buildRunPaths(opts.runDir)
  const mode = detectHealMode(paths.manifestPath)
  const modeCopy = MODE_COPY[mode]
  const runDirRel = path.relative(opts.projectRoot, opts.runDir) || opts.runDir
  const startHere: HealPromptStartEntry[] = []
  const resources: HealPromptResourceEntry[] = []

  if (fileHasContent(paths.healIndexPath)) {
    startHere.push({
      id: 'heal-index',
      field: 'healIndexMarkdown',
      path: paths.healIndexPath,
      purpose: 'First source to inspect. Lists failed tests, assertion errors, editable repos, and exact per-failure slice paths.',
    })
  } else if (fs.existsSync(paths.summaryPath)) {
    startHere.push({
      id: 'summary',
      field: 'summary',
      path: paths.summaryPath,
      purpose: 'Raw Playwright summary. Use when heal-index.md is missing or incomplete.',
    })
  }

  if (hasAnyFailureLog(paths.failedDir)) {
    resources.push({
      id: 'failed-slices',
      path: `${paths.failedDir}/<slug>/<svc>.log`,
      useWhen: 'Use the exact per-failure slice paths referenced by heal-index.md.',
    })
  }
  if (hasAnyFailureWith(paths.failedDir, 'trace-extract/failure-summary.md')) {
    resources.push({
      id: 'trace-extract',
      path: `${paths.failedDir}/<slug>/trace-extract/failure-summary.md`,
      useWhen: 'Use for UI failures when the trace extract exists; it summarizes failing actions, snapshots, failed network, and console errors.',
    })
  }
  if (hasAnyFailureWithNonEmptyDir(paths.failedDir, 'playwright-mcp')) {
    resources.push({
      id: 'playwright-mcp',
      path: `${paths.failedDir}/<slug>/playwright-mcp/`,
      useWhen: 'Use when Playwright MCP artifacts exist and the trace summary plus service logs are not enough.',
    })
  }
  if (hasAnyServiceLog(opts.runDir)) {
    resources.push({
      id: 'full-service-log',
      path: `${opts.runDir}/svc-<safeName>.log`,
      useWhen: 'Use only if a per-failure slice is missing or too short.',
    })
  }
  if (fileHasContent(paths.diagnosisJournalPath)) {
    resources.push({
      id: 'journal',
      field: 'journalMarkdown',
      path: paths.diagnosisJournalPath,
      useWhen: 'Use when prior iterations exist or the current cycle references earlier attempts.',
    })
  }
  const docsDir = featureDocsDir(paths.manifestPath)
  if (docsDir) {
    resources.push({
      id: 'feature-docs',
      path: docsDir,
      useWhen: 'Use when product requirements, acceptance criteria, or uploaded Add Test context may explain the failure.',
    })
  }
  const wikiMap = renderPersonalWikiMap(opts.personalWikiPath)
  const wikiPath = opts.personalWikiPath?.trim()
  if (wikiMap && wikiPath && directoryExists(wikiPath)) {
    resources.push({
      id: 'personal-wiki',
      path: wikiPath,
      useWhen: 'Use when the current failure seems related to prior work preserved in the personal wiki.',
    })
  }

  return {
    source: 'canary-lab/heal-agent-map',
    mode,
    runDir: opts.runDir,
    runDirRel,
    startHere,
    resources,
    boundaries: {
      fixTarget: `${modeCopy.healingDirective} ${modeCopy.testSpecRule}`,
      signalPolicy: {
        serviceOrRuntimeChange: 'restart',
        testOrConfigOnlyChange: 'rerun',
        mechanism: 'call signal_run; do not write signal files directly',
      },
    },
  }
}

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
  const promptTemplate = loadPromptTemplate(opts.promptPath)
  const promptFile = path.join(opts.runDir, 'heal-prompt.md')
  const paths = buildRunPaths(opts.runDir)
  const runDirRel = path.relative(opts.projectRoot, opts.runDir) || opts.runDir

  return ({ cycle, userGuidance, priorAgentSessionContext, consecutiveSameFailures }) => {
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
      cycle: cycle + 1,
      mode,
      summaryPath: paths.summaryPath,
      journalPath: paths.diagnosisJournalPath,
      // Plumb the stuck-cycle counter and per-run failedDir through so the
      // escalation block in `buildHealAddendum` can fire with concrete
      // `<failedDir>/<slug>/trace-extract/...` paths when the agent is stuck.
      consecutiveSameFailures,
      failedDir: paths.failedDir,
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

function featureDocsDir(manifestPath: string): string | null {
  const manifest = readManifest(manifestPath)
  const featureDir = manifest?.featureDir
  if (!featureDir) return null
  const docsDir = path.join(featureDir, 'docs')
  return directoryExists(docsDir) ? docsDir : null
}

// Optional per-failure artifact hints. Only emit a bullet when at least one
// failure dir actually contains the artifact, so the heal agent isn't told
// to look for files that don't exist. Returns the bullet line (no trailing
// newline) or an empty string. The template wraps the placeholder so an
// empty string collapses cleanly.
export function renderTraceExtractHint(failedDir: string): string {
  if (!hasAnyFailureWith(failedDir, 'trace-extract/failure-summary.md')) return ''
  return `- \`${failedDir}/<slug>/trace-extract/failure-summary.md\` — curated extract of the failing Playwright run. Read this FIRST for any UI failure: failing action with selector + error, accessibility snapshot at the failure moment, failed network, console errors. For deeper drill-down, every supporting file is in the SAME directory (\`failing-action.txt\`, \`failed-actions.txt\`, \`snapshot-at-failure.txt\`, \`snapshot-before.txt\`, \`actions.txt\`, \`network-failed.txt\`, \`console-errors.txt\`, \`metadata.txt\`) — use the \`Read\` tool on them directly. Do NOT invoke the \`playwright trace\` CLI; everything you need is already on disk.`
}

export function renderPlaywrightMcpHint(failedDir: string): string {
  if (!hasAnyFailureWithNonEmptyDir(failedDir, 'playwright-mcp')) return ''
  return `- \`${failedDir}/<slug>/playwright-mcp/\` — console logs / DOM snapshots / network captures the Playwright MCP server recorded from a re-execution of this failure. Inspect when the trace summary plus service log together still don't explain the bug, or when you need to re-drive the page.`
}

function hasAnyFailureWith(failedDir: string, relPath: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (fs.existsSync(path.join(failedDir, e.name, relPath))) return true
  }
  return false
}

function hasAnyFailureWithNonEmptyDir(failedDir: string, subDir: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = path.join(failedDir, e.name, subDir)
    if (!fs.existsSync(candidate)) continue
    try {
      const inner = fs.readdirSync(candidate).filter((f) => !f.startsWith('_'))
      if (inner.length > 0) return true
    } catch { /* ignore */ }
  }
  return false
}

function fileHasContent(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf-8').trim().length > 0
  } catch {
    return false
  }
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function hasAnyServiceLog(runDir: string): boolean {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }) } catch { return false }
  return entries.some((entry) => entry.isFile() && /^svc-.+\.log$/.test(entry.name))
}

function hasAnyFailureLog(failedDir: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(failedDir, entry.name)
    let inner: fs.Dirent[]
    try { inner = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    if (inner.some((candidate) => candidate.isFile() && candidate.name.endsWith('.log'))) return true
  }
  return false
}
