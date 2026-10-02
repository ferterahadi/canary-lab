import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type SpawnOptions } from 'node:child_process'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-process'
import { agentModelArgs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-models'
import {
  resolveWorkflowAgentRef,
  loadAgentSession,
  type AgentSessionRef,
} from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-log'
import {
  loadSubagentThreads,
} from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-subagents'
import {
  listCodexSessionLogs,
  claudeSessionLogPath,
  locateClaudeSessionLog,
} from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-paths'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import { testEnvironment, ports } from './evaluator'
import { releasePorts } from '../../apps/web-server/src/features/runs/logic/runtime/port-allocator'
import { canaryRunDir, json, quote, readJson, sha, write } from './files'
import { prepareIsolation, prepareNativeIsolation, isolatedShell } from './isolation'
import type { Attempt, ExecutionResult, StudyManifest, Usage, UsageAttribution } from './types'
import type { AgentSpawnArgs } from '../../apps/web-server/src/features/runs/logic/runtime/heal-agent-spawn'
import { loadPromptTemplate, promptPath } from '../../apps/web-server/src/shared/prompts'
import { runtimeEnvironment, serviceCommand, writeRunbook, services } from './runtime'
import { stopAttemptServices } from './cleanup'
import { stageIntervals, type StageBoundary } from './telemetry'
import { parseUsage, sessionRole } from './usage'
import { attributeUsage, assessPolicy, type SessionInput } from './attribution'
import { claudePermissionArgs, claudeStudyCommand, REPAIR_ALLOWED_TOOLS } from './claude-permissions'
import { DEFAULT_DIAGNOSIS_POLICY } from '../../shared/diagnosis-policy'

export function freezeToolConfig(command: string, agent: 'claude' | 'codex', args: AgentSpawnArgs, codexToolArgs: string[] = []): string {
  const suffix = args.promptFile ? ` -- ${JSON.stringify(`@${args.promptFile}`)}` : ''
  if (suffix && !command.endsWith(suffix)) throw new Error('Heal command changed its prompt suffix; review study tool isolation')
  const head = suffix ? command.slice(0, -suffix.length) : command
  if (agent === 'codex' && !codexToolArgs.length) throw new Error('Missing frozen Codex tool policy')
  return `${head} ${agent === 'claude' ? '--strict-mcp-config' : codexToolArgs.map(quote).join(' ')}${suffix}`
}

// Resolve by our pinned ID after spawn; Claude may shorten its private cwd slug.
export function pinnedClaudeSessionRef(cwd: string, sessionId: string): AgentSessionRef {
  return { agent: 'claude', sessionId, logPath: locateClaudeSessionLog(cwd, sessionId) ?? claudeSessionLogPath(cwd, sessionId) }
}

export function sessionEvidence(ref: AgentSessionRef | null, output: string, pin?: { model: string; effort: string }): Usage | null {
  if (!ref || !fs.existsSync(ref.logPath)) return null
  const raw = fs.readFileSync(ref.logPath, 'utf8')
  write(path.join(output, 'session.jsonl'), raw)
  const session = loadAgentSession(ref)
  json(path.join(output, 'session-events.json'), session)
  if (pin && sessionRole(ref.agent, raw) === 'repair' && ((session.meta.model && session.meta.model !== pin.model) || (session.meta.effort && session.meta.effort !== pin.effort))) {
    throw new Error(`Agent settings differ from the frozen pin: ${JSON.stringify(session.meta)}`)
  }
  return parseUsage(ref.agent, raw)
}

export function captureAttemptSessions(agent: 'codex' | 'claude', cwd: string, startedAt: string, output: string,
  pin: { model: string; effort: string }, claudeRef: AgentSessionRef | null): Usage | null {
  const refs = agent === 'codex' ? listCodexSessionLogs(cwd, startedAt) : claudeRef ? [claudeRef] : []
  const threads = agent === 'claude' && claudeRef ? loadSubagentThreads(claudeRef) : []
  refs.push(...threads.map((thread) => ({ agent: 'claude' as const, sessionId: thread.agentId, logPath: thread.logPath })))
  const unique = [...new Map(refs.map((ref) => [ref.sessionId, ref])).values()]
  const inputs: SessionInput[] = unique.map((ref) => {
    sessionEvidence(ref, path.join(output, 'sessions', ref.sessionId))
    const thread = threads.find((item) => item.agentId === ref.sessionId)
    return { sessionId: ref.sessionId, evidence: `sessions/${ref.sessionId}`, raw: fs.existsSync(ref.logPath) ? fs.readFileSync(ref.logPath, 'utf8') : null,
      ...(thread && claudeRef ? { parentSessionId: claudeRef.sessionId, parentToolId: thread.parentToolId } : {}) }
  })
  const attribution = attributeUsage(agent, inputs)
  const primary = unique.find((ref) => attribution.sessions.some((row) => row.sessionId === ref.sessionId && row.role === 'primary'))
  if (primary) sessionEvidence(primary, output)
  json(path.join(output, 'sessions/index.json'), inputs.map(({ raw: _raw, ...input }) => ({ agent, ...input,
    role: attribution.sessions.find((row) => row.sessionId === input.sessionId.replace(/^agent-/, ''))?.role ?? 'unknown' })))
  json(path.join(output, 'usage-breakdown.json'), attribution)
  // Capture every available transcript before rejecting a pin violation.
  for (const ref of unique) sessionEvidence(ref, path.join(output, 'sessions', ref.sessionId), pin)
  return attribution.total
}

// Canary pins its session in a sidecar; Claude can shorten long cwd slugs, so
// newest-by-cwd discovery can miss a transcript that the pinned ref resolves.
export function captureExecutionEvidence(manifest: StudyManifest, attempt: Attempt, cwd: string, startedAt: string, root: string,
  ref: AgentSessionRef | null = attempt.agent === 'claude' ? resolveWorkflowAgentRef(cwd) : null) {
  const usage = captureAttemptSessions(attempt.agent, cwd, startedAt, root, manifest.pins[attempt.agent], ref)
  const attribution = readJson<UsageAttribution>(path.join(root, 'usage-breakdown.json'))
  const adherence = attempt.variant ? assessPolicy(attempt.variant.diagnosisPolicy, attribution) : undefined
  if (adherence) json(path.join(root, 'policy-adherence.json'), adherence)
  return { usage, attribution, ...(adherence ? { adherence } : {}) }
}

export async function runPlain(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal,
  scriptedAgent?: { command: string; args: string[] },
): Promise<ExecutionResult> {
  const allocated = await ports()
  const isolation = scriptedAgent ? await prepareIsolation(manifest.root, root, 'plain', manifest.design?.mode === 'replay') : null
  const native = scriptedAgent ? null : await prepareNativeIsolation(manifest.root, root, 'plain', attempt.agent, manifest.pins.codex.executable)
  const pin = manifest.pins[attempt.agent]
  const sessionId = randomUUID()
  const startedAt = new Date().toISOString()
  writeRunbook(root, allocated, testEnvironment(root, allocated))
  const prompt = fs.readFileSync(path.join(__dirname, 'plain-prompt.md'), 'utf8')
  write(path.join(root, 'prompt.md'), prompt)
  const args = attempt.agent === 'claude'
    ? [...buildClaudeAgenticArgs(prompt, { ...pin, sessionId }).filter((arg) => arg !== '--dangerously-skip-permissions'), ...claudePermissionArgs(REPAIR_ALLOWED_TOOLS), '--setting-sources', '', ...(native ? ['--settings', native.claudeSettings] : [])]
    : ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', ...agentModelArgs('codex', pin), ...(manifest.codexToolArgs ?? []), ...(native?.codexArgs ?? []), prompt]
  const stream = path.join(root, 'agent-output.jsonl')
  const handle = runAgentProcess({
    command: scriptedAgent?.command ?? attempt.agent, args: scriptedAgent?.args ?? args, cwd: root, idleMs: manifest.budgetMs, captureStdout: false,
    resolveBinary: () => pin.executable ?? null,
    activityPath: stream,
    onChunk: (chunk) => fs.appendFileSync(stream, chunk),
    spawnImpl: ((cmd: string, argv: readonly string[], options: SpawnOptions) =>
      isolation ? spawn('/usr/bin/sandbox-exec', ['-f', isolation, cmd, ...argv], options) : spawn(cmd, argv, { ...options, env: { ...options.env, ...runtimeEnvironment(root) } })) as typeof spawn,
  })
  const stop = (): void => handle.stop('SIGTERM')
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const result = await handle.done
    const ref = attempt.agent === 'claude' ? pinnedClaudeSessionRef(root, sessionId) : null
    const observedTests = path.join(root, 'test-executions.jsonl')
    return { status: signal.aborted ? 'interrupted' : result.code === 0 ? 'finished' : 'infrastructure-error',
      reason: `Agent exit: ${result.code}; signal: ${result.signal}`, ...(scriptedAgent ? { usage: null } : captureExecutionEvidence(manifest, attempt, root, startedAt, root, ref)),
      testExecutions: fs.existsSync(observedTests) ? fs.readFileSync(observedTests, 'utf8').trim().split('\n').filter(Boolean).length : null }
  } finally {
    signal.removeEventListener('abort', stop)
    signalProcessTree(handle.child, 'SIGKILL', { detachedProcessGroup: true })
    try { await stopAttemptServices(root, Object.values(allocated)) }
    finally { releasePorts(Object.values(allocated)) }
  }
}

export async function runCanary(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal,
  scriptedAgent?: (args: AgentSpawnArgs) => string,
): Promise<ExecutionResult> {
  // Imported only after the worker removes the demo's global model override.
  const [{ RunOrchestrator }, { realPtyFactory }, { buildOrchestratorHealPrompt }, { makeAgentSpawnCommandBuilder }, { RunnerLog }] = await Promise.all([
    import('../../apps/web-server/src/features/runs/logic/runtime/orchestrator'),
    import('../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'),
    import('../../apps/web-server/src/features/runs/logic/runtime/auto-heal'),
    import('../../apps/web-server/src/features/runs/logic/runtime/heal-agent-spawn'),
    import('../../apps/web-server/src/features/runs/logic/runtime/runner-log'),
  ])
  const { defaultPlaywrightSpawner } = await import('../../apps/web-server/src/features/runs/logic/runtime/run-spawn')
  const allocated = await ports()
  const isolation = scriptedAgent ? await prepareIsolation(manifest.root, root, 'canary', manifest.design?.mode === 'replay') : null
  const native = scriptedAgent ? null : await prepareNativeIsolation(manifest.root, root, 'canary', attempt.agent, manifest.pins.codex.executable)
  const runDir = canaryRunDir(root)
  const startedAt = new Date().toISOString()
  const pin = manifest.pins[attempt.agent]
  fs.mkdirSync(runDir, { recursive: true })
  // These API journeys use Playwright CLI in both arms. Disable the optional
  // browser MCP server (normally fetched at @latest) and inherited connectors,
  // so an unfrozen external tool cannot change the experiment between attempts.
  const templatePath = path.join(root, 'heal-template.md')
  write(templatePath, loadPromptTemplate(promptPath('heal-agent.md')).replace('{{playwrightMcpHint}}', ''))
  json(path.join(root, 'canary-lab.config.json'), { autoProposePr: false })
  const feature = {
    name: 'storefront-journey', description: 'Storefront repair study', envs: ['local'], featureDir: path.join(root, 'suite'), healOnFailureThreshold: 4,
    repos: services.map((name) => ({ name: `${name}-service`, localPath: path.join(root, 'app'), startCommands: [{
      name: `${name}-service`, command: serviceCommand(name), ports: [{ name, env: 'PORT' }],
      healthCheck: { http: { url: `http://127.0.0.1:\${port.${name}}/` } },
    }] })),
  }
  const buildSpawn = makeAgentSpawnCommandBuilder(attempt.agent, { models: pin, mcpConfigFile: path.join(runDir, 'mcp-config.json') })
  const real = realPtyFactory()
  const ptyFactory: typeof real = (opts) => real({ ...opts, env: { ...opts.env, ...runtimeEnvironment(root), ...testEnvironment(root, allocated), CANARY_LAB_PROJECT_ROOT: root } })
  const buildPrompt = buildOrchestratorHealPrompt({ agent: attempt.agent, projectRoot: root, runDir, promptPath: templatePath, diagnosisPolicy: attempt.variant?.diagnosisPolicy })
  const clockStart = performance.now()
  const stageEvents: StageBoundary[] = []
  const event = (name: string): void => {
    const boundary = { name, at: new Date().toISOString(), elapsedMs: performance.now() - clockStart }
    stageEvents.push(boundary)
    fs.appendFileSync(path.join(root, 'stage-events.jsonl'), JSON.stringify(boundary) + '\n')
  }
  event('adapter-started')
  let testExecutions = 0
  const orchestrator = new RunOrchestrator({
    feature, projectRoot: root, runId: attempt.id, runDir, portMap: new Map(Object.entries(allocated)), ptyFactory,
    runnerLog: new RunnerLog(path.join(runDir, 'runner.log')), executionType: 'benchmark',
    models: { heal: pin, commit: pin }, healAgentTimeoutMs: manifest.budgetMs, healAgentIdleTimeoutMs: manifest.budgetMs,
    playwrightSpawner: (args) => {
      const invocation = defaultPlaywrightSpawner(args)
      // This contributor command runs TS source; the product's compiled default
      // intentionally points at its sibling JS reporter in dist/.
      return { ...invocation, command: invocation.command.replace('summary-reporter.js', 'summary-reporter.ts') }
    },
    autoHeal: { agent: attempt.agent, diagnosisPolicy: attempt.variant?.diagnosisPolicy, buildCyclePrompt: (args) => {
      const prompt = buildPrompt(args)
      const receipt = { cycle: args.cycle, diagnosisPolicy: attempt.variant?.diagnosisPolicy ?? DEFAULT_DIAGNOSIS_POLICY, digest: sha(prompt), bytes: Buffer.byteLength(prompt) }
      write(path.join(root, `prompts/cycle-${args.cycle}.md`), prompt)
      json(path.join(root, `prompts/cycle-${args.cycle}.json`), receipt)
      return prompt
    },
      buildSpawnCommand: (args) => {
        if (scriptedAgent && isolation) return isolatedShell(isolation, scriptedAgent(args))
        const built = buildSpawn({ ...args, binaryPath: pin.executable, workspaceRoot: runDir, mcpOutputDir: undefined, isolationSettingsFile: native!.claudeSettings })
        // Native profiles replace the legacy --sandbox option; keeping both
        // would make Codex silently ignore the study's read-deny profile.
        const frozen = freezeToolConfig(attempt.agent === 'codex' ? built.replace(' --sandbox workspace-write', '') : built,
          attempt.agent, args, [...(manifest.codexToolArgs ?? []), ...native!.codexArgs])
        return attempt.agent === 'claude' ? claudeStudyCommand(frozen, REPAIR_ALLOWED_TOOLS) : frozen
      } },
  })
  for (const name of ['service-started', 'health-check', 'playwright-started', 'playwright-exit', 'heal-cycle-started', 'agent-started', 'agent-exit', 'signal-accepted', 'run-complete'] as const) {
    orchestrator.on(name, () => event(name))
  }
  orchestrator.on('playwright-started', () => { testExecutions++ })
  orchestrator.on('agent-output', ({ chunk }) => fs.appendFileSync(path.join(root, 'agent-terminal.log'), chunk))
  const stop = (): void => { void orchestrator.stop('aborted').catch((error) => write(path.join(root, 'stop-error.txt'), String(error))) }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const status = await orchestrator.runFullCycle()
    await orchestrator.stop(status)
    return { status: signal.aborted ? 'interrupted' : 'finished', reason: `Canary terminal status: ${status}`,
      testExecutions, ...(scriptedAgent ? { usage: null } : captureExecutionEvidence(manifest, attempt, runDir, startedAt, root)) }
  } finally {
    signal.removeEventListener('abort', stop)
    await orchestrator.stop('aborted')
    releasePorts(Object.values(allocated))
    event('capture-complete')
    json(path.join(root, 'stage-intervals.json'), stageIntervals(stageEvents))
  }
}
