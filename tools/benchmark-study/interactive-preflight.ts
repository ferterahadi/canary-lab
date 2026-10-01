import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { canaryRunDir, copy, digest, json, quote, write } from './files'
import { prepareNativeIsolation } from './isolation'
import { runtimeEnvironment } from './runtime'
import { captureAttemptSessions, freezeToolConfig, pinnedClaudeSessionRef } from './agents'
import { buildAgentSpawnCommand } from '../../apps/web-server/src/features/runs/logic/runtime/heal-agent-spawn'
import { realPtyFactory, type PtyHandle } from '../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'
import { ensureClaudeWorkspaceTrusted } from '../../apps/web-server/src/features/agent-sessions/logic/agent-workspace-trust'
import { parseAgentSessionLine } from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-parse'
import { loadPromptTemplate, renderPromptTemplate } from '../../apps/web-server/src/shared/prompts'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import { claudeStudyCommand } from './claude-permissions'
import type { StudyManifest } from './types'

export type ProbeOutcome = { status: 'pending' } | { status: 'passed' } |
  { status: 'denied' | 'failed'; reason: string; toolId: string }

export function probeOutcome(raw: string, marker: string, command: string): ProbeOutcome {
  const probeCalls = new Set<string>()
  for (const line of raw.split('\n')) {
    for (const event of parseAgentSessionLine('claude', line)) {
      if (event.kind === 'tool-call' && event.name === 'Bash' && event.toolId &&
        event.input && typeof event.input === 'object' && 'command' in event.input &&
        event.input.command === command) probeCalls.add(event.toolId)
      if (event.kind !== 'tool-result' || !event.toolId || !probeCalls.has(event.toolId)) continue
      if (!event.isError && event.output.includes(marker)) return { status: 'passed' }
      if (!event.isError) continue
      const auto = event.output.match(/Permission for this action was denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/)
      if (auto) return { status: 'denied', reason: auto[1], toolId: event.toolId }
      if (/permission[^\n]*denied|denied[^\n]*permission/i.test(event.output)) {
        return { status: 'denied', reason: event.output.slice(0, 500), toolId: event.toolId }
      }
      return { status: 'failed', reason: event.output.slice(0, 500), toolId: event.toolId }
    }
  }
  return { status: 'pending' }
}

export function hasProbeResult(raw: string, marker: string): boolean {
  return raw.split('\n').some((line) => parseAgentSessionLine('claude', line).some((event) =>
    event.kind === 'tool-result' && !event.isError && event.output.includes(marker)))
}

export function hasPinnedProbeResult(cwd: string, sessionId: string, marker: string): boolean {
  const { logPath } = pinnedClaudeSessionRef(cwd, sessionId)
  return fs.existsSync(logPath) && hasProbeResult(fs.readFileSync(logPath, 'utf8'), marker)
}

export function pinnedProbeOutcome(cwd: string, sessionId: string, marker: string, command: string): ProbeOutcome {
  const { logPath } = pinnedClaudeSessionRef(cwd, sessionId)
  return fs.existsSync(logPath) ? probeOutcome(fs.readFileSync(logPath, 'utf8'), marker, command) : { status: 'pending' }
}

export function waitForPinnedProbe(args: { pty: Pick<PtyHandle, 'onExit'>; cwd: string; sessionId: string;
  marker: string; command: string; work: string; timeoutMs: number }): Promise<void> {
  const { pty, cwd, sessionId, marker, command, work, timeoutMs } = args
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let poll: ReturnType<typeof setInterval> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let exit: { dispose(): void } | undefined
    const cleanup = (): void => {
      if (poll) clearInterval(poll)
      if (timer) clearTimeout(timer)
      exit?.dispose()
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
    }
    const interrupted = (): void => { if (settled) return; settled = true; cleanup(); reject(new Error('Interactive preflight interrupted')) }
    const observe = (): boolean => {
      if (settled) return true
      const outcome = pinnedProbeOutcome(cwd, sessionId, marker, command)
      if (outcome.status === 'pending') return false
      settled = true
      cleanup()
      if (outcome.status === 'passed') resolve()
      else {
        json(path.join(work, outcome.status === 'denied' ? 'permission-denial.json' : 'probe-error.json'),
          { status: outcome.status, reason: outcome.reason, toolId: outcome.toolId, sessionId })
        reject(new Error(`Interactive preflight ${outcome.status}: ${outcome.reason}; inspect ${work}`))
      }
      return true
    }
    exit = pty.onExit(({ exitCode }) => {
      try {
        if (observe()) return
        settled = true
        cleanup()
        reject(new Error(`Interactive preflight exited ${exitCode}; inspect ${work}`))
      } catch (error) { settled = true; cleanup(); reject(error) }
    })
    if (settled) { exit.dispose(); return }
    poll = setInterval(() => { try { observe() } catch (error) { settled = true; cleanup(); reject(error) } }, 500)
    timer = setTimeout(() => { settled = true; cleanup(); reject(new Error(`Interactive preflight timed out; inspect ${work}`)) }, timeoutMs)
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted)
  })
}

// Keep packet creation separate from launching Claude so a human can review the
// exact probe, sandbox settings, and paid invocation before supervised use.
export async function prepareInteractivePreflight(manifest: Pick<StudyManifest, 'root' | 'pins'>): Promise<{
  work: string; runDir: string; marker: string; command: string; sessionId: string;
  spawnCommand: string; before: string
}> {
  const work = path.join(manifest.root, 'attempts', `interactive-preflight-${Date.now()}`)
  copy(path.join(manifest.root, 'frozen/single-service'), path.join(work, 'app'))
  const before = digest(path.join(work, 'app'))
  const runDir = canaryRunDir(work)
  json(path.join(runDir, 'e2e-summary.json'), { probe: 'local-summary' })
  const native = await prepareNativeIsolation(manifest.root, work, 'canary', 'claude')
  const marker = `INTERACTIVE_RUNTIME_OK_${randomUUID()}`
  const denied = [path.join(manifest.root, 'study.json'), path.join(manifest.root, 'frozen/single-service/REQUIREMENTS.md')]
  const script = ['set -eu', ...denied.map((file) =>
    `if /bin/cat ${quote(file)} >/dev/null 2>denial.log; then exit 91; fi; /usr/bin/grep -qi 'operation not permitted' denial.log`),
  `if /usr/bin/touch ${quote(native.claudeSettings)} 2>denial.log; then exit 92; fi; /usr/bin/grep -qi 'operation not permitted' denial.log`,
  `echo ${quote(marker)}`].join('\n')
  write(path.join(work, 'denial-probe.sh'), script)
  const probeScript = path.join(work, 'interactive-probe.sh')
  write(probeScript, `set -eu\ncd ${quote(work)}\ncat app/shared/durable.ts\npython3 -c ${quote(
    `import json\nd=json.load(open(${JSON.stringify(path.relative(work, path.join(runDir, 'e2e-summary.json')))}))\nassert d['probe']=='local-summary'\nprint(json.dumps(d,indent=1)[:2500])`)}\n/bin/bash ./denial-probe.sh\n`)
  const command = `/bin/bash ${quote(probeScript)}`
  const promptFile = path.join(runDir, 'prompt.md')
  write(promptFile, renderPromptTemplate(loadPromptTemplate(path.join(__dirname, 'interactive-preflight-prompt.md')), { command }))
  const sessionId = randomUUID()
  const pin = manifest.pins.claude
  const args = { sessionId, promptFile, binaryPath: pin.executable, models: pin, writableDirs: [path.join(work, 'app')], isolationSettingsFile: native.claudeSettings }
  const spawnCommand = claudeStudyCommand(freezeToolConfig(buildAgentSpawnCommand('claude', args), 'claude', args), [`Bash(${command})`])
  json(path.join(work, 'invocation.json'), { spawnCommand, cwd: runDir, sessionId, marker, timeoutMs: 120_000 })
  return { work, runDir, marker, command, sessionId, spawnCommand, before }
}

// Headless preflight misses Claude's interactive permission gates. Use the same
// launcher and nested run cwd as Canary, and require actual tool-result evidence.
export async function interactivePreflight(manifest: StudyManifest): Promise<string> {
  const { work, runDir, marker, command, sessionId, spawnCommand, before } = await prepareInteractivePreflight(manifest)
  const trust = ensureClaudeWorkspaceTrusted(runDir)
  if (trust.outcome === 'unavailable') throw new Error(`Interactive preflight trust unavailable: ${trust.reason}`)
  const pin = manifest.pins.claude
  const startedAt = new Date().toISOString()
  const pty = realPtyFactory()({ command: spawnCommand, cwd: runDir, env: runtimeEnvironment(work), cols: 160, rows: 45 })
  const output = pty.onData((chunk) => fs.appendFileSync(path.join(work, 'agent-terminal.log'), chunk))
  try {
    await waitForPinnedProbe({ pty, cwd: runDir, sessionId, marker, command, work, timeoutMs: 120_000 })
    if (before !== digest(path.join(work, 'app'))) throw new Error('Interactive preflight changed application files')
    json(path.join(work, 'verdict.json'), { passed: true, localPythonRead: true, privateReadsDenied: true, settingsWriteDenied: true })
  } finally {
    signalProcessTree(pty, 'SIGKILL', { detachedProcessGroup: true })
    output.dispose()
    json(path.join(work, 'usage.json'), captureAttemptSessions('claude', runDir, startedAt, work, pin, pinnedClaudeSessionRef(runDir, sessionId)))
  }
  return path.relative(manifest.root, work)
}
