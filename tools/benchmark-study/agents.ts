import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type SpawnOptions } from 'node:child_process'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-process'
import { agentModelArgs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-models'
import { claudeSessionLogPath, locateMostRecentAgentSessionRef, loadAgentSession, loadSubagentThreads, type AgentSessionRef } from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-log'
import { listCodexSessionLogs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-paths'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import { services, testEnvironment, ports } from './evaluator'
import { releasePorts } from '../../apps/web-server/src/features/runs/logic/runtime/port-allocator'
import { canaryRunDir, json, quote, write } from './files'
import { prepareIsolation, prepareNativeIsolation, isolatedShell } from './isolation'
import type { Attempt, ExecutionResult, StudyManifest, Usage } from './types'
import type { AgentSpawnArgs } from '../../apps/web-server/src/features/runs/logic/runtime/heal-agent-spawn'
import { loadPromptTemplate, promptPath } from '../../apps/web-server/src/shared/prompts'
import { runtimeEnvironment, serviceCommand, writeRunbook } from './runtime'
import { stopAttemptServices } from './cleanup'

export function freezeToolConfig(command: string, agent: 'claude' | 'codex', args: AgentSpawnArgs, codexToolArgs: string[] = []): string {
  const suffix = args.promptFile ? ` -- ${JSON.stringify(`@${args.promptFile}`)}` : ''
  if (suffix && !command.endsWith(suffix)) throw new Error('Heal command changed its prompt suffix; review study tool isolation')
  const head = suffix ? command.slice(0, -suffix.length) : command
  if (agent === 'codex' && !codexToolArgs.length) throw new Error('Missing frozen Codex tool policy')
  return `${head} ${agent === 'claude' ? '--strict-mcp-config' : codexToolArgs.map(quote).join(' ')}${suffix}`
}

export function parseUsage(agent: 'codex' | 'claude', raw: string): Usage | null {
  const messages = new Map<string, Usage>()
  let codex: Usage | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (agent === 'codex') {
      const usage = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload.info?.total_token_usage : null
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        codex = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cached_input_tokens ?? null, cacheWrite: usage.cache_write_input_tokens ?? null }
      }
    } else {
      const usage = row.type === 'assistant' ? row.message?.usage : null
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' && row.message.id) {
        messages.set(row.message.id, { input: usage.input_tokens, output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? null, cacheWrite: usage.cache_creation_input_tokens ?? null })
      }
    }
  }
  if (agent === 'codex') return codex
  if (!messages.size) return null
  const rows = [...messages.values()]
  const sum = (key: keyof Usage): number | null => rows.every((row) => row[key] !== null) ? rows.reduce((n, row) => n + row[key]!, 0) : null
  return { input: sum('input')!, output: sum('output')!, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') }
}
export function sessionRole(agent: 'codex' | 'claude', raw: string): 'repair' | 'approval-review' {
  if (agent === 'codex') for (const line of raw.split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'session_meta') return row.payload?.thread_source === 'guardian_review' || row.payload?.source?.subagent?.other === 'guardian' ? 'approval-review' : 'repair'
  }
  return 'repair'
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

export function groupUsage(agent: 'codex' | 'claude', raws: string[]): Usage | null {
  const spawns = new Set<string>()
  const rejected = new Set<string>()
  for (const raw of raws) for (const line of raw.split('\n')) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'response_item' && row.payload?.type === 'function_call' && row.payload.name === 'spawn_agent') spawns.add(row.payload.call_id)
    if (row.type === 'response_item' && row.payload?.type === 'function_call_output' &&
      typeof row.payload.output === 'string' && row.payload.output.startsWith('collab spawn failed:')) rejected.add(row.payload.call_id)
    if (row.type === 'assistant') for (const block of row.message?.content ?? []) {
      if (block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)) spawns.add(block.id)
    }
  }
  for (const id of rejected) spawns.delete(id)
  // Approval reviewers are platform sessions, not missing diagnosis agents.
  // Only explicit launch rejection proves a requested child never started.
  const repairRaws = raws.filter((raw) => sessionRole(agent, raw) === 'repair')
  if (!repairRaws.length || spawns.size >= repairRaws.length) return null
  const rows = agent === 'claude' ? [parseUsage(agent, raws.join('\n'))] : raws.map((raw) => parseUsage(agent, raw))
  if (rows.some((row) => row === null)) return null
  const sum = (key: keyof Usage): number | null => rows.every((row) => row![key] !== null) ? rows.reduce((total, row) => total + row![key]!, 0) : null
  return { input: sum('input')!, output: sum('output')!, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') }
}

export function captureAttemptSessions(agent: 'codex' | 'claude', cwd: string, startedAt: string, output: string,
  pin: { model: string; effort: string }, claudeRef: AgentSessionRef | null): Usage | null {
  const refs = agent === 'codex' ? listCodexSessionLogs(cwd, startedAt).reverse() : claudeRef ? [claudeRef] : []
  if (agent === 'claude' && claudeRef) refs.push(...loadSubagentThreads(claudeRef).map((thread) => ({ agent: 'claude' as const, sessionId: thread.agentId, logPath: thread.logPath })))
  const unique = [...new Map(refs.map((ref) => [ref.sessionId, ref])).values()]
  const raws: string[] = []
  for (const ref of unique) {
    sessionEvidence(ref, path.join(output, 'sessions', ref.sessionId), pin)
    if (fs.existsSync(ref.logPath)) raws.push(fs.readFileSync(ref.logPath, 'utf8'))
  }
  const primary = unique.find((ref) => fs.existsSync(ref.logPath) && sessionRole(agent, fs.readFileSync(ref.logPath, 'utf8')) === 'repair')
  if (primary) sessionEvidence(primary, output, pin)
  json(path.join(output, 'sessions/index.json'), unique.map((ref) => ({ agent: ref.agent, sessionId: ref.sessionId,
    role: fs.existsSync(ref.logPath) ? sessionRole(agent, fs.readFileSync(ref.logPath, 'utf8')) : 'unknown', evidence: `sessions/${ref.sessionId}` })))
  const total = groupUsage(agent, raws)
  const approvalRaws = raws.filter((raw) => sessionRole(agent, raw) === 'approval-review')
  json(path.join(output, 'usage-breakdown.json'), { total, repair: groupUsage(agent, raws.filter((raw) => sessionRole(agent, raw) === 'repair')),
    approvalReviews: approvalRaws.map((raw) => parseUsage(agent, raw)), approvalSessionCount: approvalRaws.length })
  return total
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
    ? [...buildClaudeAgenticArgs(prompt, { ...pin, sessionId }).filter((arg) => arg !== '--dangerously-skip-permissions'), '--permission-mode', 'auto', '--setting-sources', '', ...(native ? ['--settings', native.claudeSettings] : [])]
    : ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', ...agentModelArgs('codex', pin), ...(manifest.codexToolArgs ?? []), ...(native?.codexArgs ?? []), prompt]
  const stream = path.join(root, 'agent-output.jsonl')
  const handle = runAgentProcess({
    command: scriptedAgent?.command ?? attempt.agent, args: scriptedAgent?.args ?? args, cwd: root, idleMs: manifest.budgetMs, captureStdout: false,
    resolveBinary: () => pin.executable ?? null,
    activityPath: attempt.agent === 'claude' ? claudeSessionLogPath(root, sessionId) : stream,
    onChunk: (chunk) => fs.appendFileSync(stream, chunk),
    spawnImpl: ((cmd: string, argv: readonly string[], options: SpawnOptions) =>
      isolation ? spawn('/usr/bin/sandbox-exec', ['-f', isolation, cmd, ...argv], options) : spawn(cmd, argv, { ...options, env: { ...options.env, ...runtimeEnvironment(root) } })) as typeof spawn,
  })
  const stop = (): void => handle.stop('SIGTERM')
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const result = await handle.done
    const ref = attempt.agent === 'claude' ? { agent: attempt.agent, sessionId, logPath: claudeSessionLogPath(root, sessionId) } : null
    const observedTests = path.join(root, 'test-executions.jsonl')
    return { status: signal.aborted ? 'interrupted' : result.code === 0 ? 'finished' : 'infrastructure-error',
      reason: `Agent exit: ${result.code}; signal: ${result.signal}`, usage: scriptedAgent ? null : captureAttemptSessions(attempt.agent, root, startedAt, root, pin, ref),
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
  const [{ RunOrchestrator }, { realPtyFactory }, { buildOrchestratorHealPrompt, makeAgentSpawnCommandBuilder }, { RunnerLog }] = await Promise.all([
    import('../../apps/web-server/src/features/runs/logic/runtime/orchestrator'),
    import('../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'),
    import('../../apps/web-server/src/features/runs/logic/runtime/auto-heal'),
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
    autoHeal: { agent: attempt.agent, buildCyclePrompt: buildOrchestratorHealPrompt({ agent: attempt.agent, projectRoot: root, runDir, promptPath: templatePath }),
      buildSpawnCommand: (args) => {
        if (scriptedAgent && isolation) return isolatedShell(isolation, scriptedAgent(args))
        const built = buildSpawn({ ...args, binaryPath: pin.executable, workspaceRoot: runDir, mcpOutputDir: undefined, isolationSettingsFile: native!.claudeSettings })
        // Native profiles replace the legacy --sandbox option; keeping both
        // would make Codex silently ignore the study's read-deny profile.
        return freezeToolConfig(attempt.agent === 'codex' ? built.replace(' --sandbox workspace-write', '') : built,
          attempt.agent, args, [...(manifest.codexToolArgs ?? []), ...native!.codexArgs])
      } },
  })
  orchestrator.on('playwright-started', () => { testExecutions++ })
  orchestrator.on('agent-output', ({ chunk }) => fs.appendFileSync(path.join(root, 'agent-terminal.log'), chunk))
  const stop = (): void => { void orchestrator.stop('aborted').catch((error) => write(path.join(root, 'stop-error.txt'), String(error))) }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const status = await orchestrator.runFullCycle()
    await orchestrator.stop(status)
    return { status: signal.aborted ? 'interrupted' : 'finished', reason: `Canary terminal status: ${status}`,
      testExecutions, usage: scriptedAgent ? null : captureAttemptSessions(attempt.agent, runDir, startedAt, root, pin, attempt.agent === 'claude' ? locateMostRecentAgentSessionRef(runDir) : null) }
  } finally {
    signal.removeEventListener('abort', stop)
    await orchestrator.stop('aborted')
    releasePorts(Object.values(allocated))
  }
}
