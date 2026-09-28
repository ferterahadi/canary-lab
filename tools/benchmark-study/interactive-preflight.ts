import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { canaryRunDir, copy, digest, json, quote, write } from './files'
import { prepareNativeIsolation } from './isolation'
import { runtimeEnvironment } from './runtime'
import { captureAttemptSessions, freezeToolConfig } from './agents'
import { buildAgentSpawnCommand } from '../../apps/web-server/src/features/runs/logic/runtime/heal-agent-spawn'
import { realPtyFactory } from '../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'
import { ensureClaudeWorkspaceTrusted } from '../../apps/web-server/src/features/agent-sessions/logic/agent-workspace-trust'
import { claudeSessionLogPath } from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-log'
import { loadPromptTemplate, renderPromptTemplate } from '../../apps/web-server/src/shared/prompts'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import type { StudyManifest } from './types'

export function hasProbeResult(raw: string, marker: string): boolean {
  return raw.split('\n').some((line) => {
    let row
    try { row = JSON.parse(line) } catch { return false }
    return row?.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some((block: { type?: string; content?: unknown; is_error?: boolean }) =>
      block.type === 'tool_result' && !block.is_error && typeof block.content === 'string' && block.content.includes(marker))
  })
}

// Headless preflight misses Claude's interactive permission gates. Use the same
// launcher and nested run cwd as Canary, and require actual tool-result evidence.
export async function interactivePreflight(manifest: StudyManifest): Promise<string> {
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
  const command = `cd ${quote(work)} && cat app/shared/durable.ts && python3 -c ${quote(
    `import json\nd=json.load(open(${JSON.stringify(path.relative(work, path.join(runDir, 'e2e-summary.json')))}))\nassert d['probe']=='local-summary'\nprint(json.dumps(d,indent=1)[:2500])`)} && /bin/bash ./denial-probe.sh`
  const promptFile = path.join(runDir, 'prompt.md')
  write(promptFile, renderPromptTemplate(loadPromptTemplate(path.join(__dirname, 'interactive-preflight-prompt.md')), { command }))
  const trust = ensureClaudeWorkspaceTrusted(runDir)
  if (trust.outcome === 'unavailable') throw new Error(`Interactive preflight trust unavailable: ${trust.reason}`)
  const sessionId = randomUUID()
  const pin = manifest.pins.claude
  const args = { sessionId, promptFile, binaryPath: pin.executable, models: pin, writableDirs: [path.join(work, 'app')], isolationSettingsFile: native.claudeSettings }
  const spawnCommand = freezeToolConfig(buildAgentSpawnCommand('claude', args), 'claude', args)
  json(path.join(work, 'invocation.json'), { spawnCommand, cwd: runDir, sessionId, marker, timeoutMs: 120_000 })
  const startedAt = new Date().toISOString()
  const logPath = claudeSessionLogPath(runDir, sessionId)
  const pty = realPtyFactory()({ command: spawnCommand, cwd: runDir, env: runtimeEnvironment(work), cols: 160, rows: 45 })
  const output = pty.onData((chunk) => fs.appendFileSync(path.join(work, 'agent-terminal.log'), chunk))
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearInterval(poll); clearTimeout(timer); exit.dispose(); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted) }
      const interrupted = (): void => { cleanup(); reject(new Error('Interactive preflight interrupted')) }
      const exit = pty.onExit(({ exitCode }) => { cleanup(); reject(new Error(`Interactive preflight exited ${exitCode}; inspect ${work}`)) })
      const poll = setInterval(() => {
        try {
          if (fs.existsSync(logPath) && hasProbeResult(fs.readFileSync(logPath, 'utf8'), marker)) { cleanup(); resolve() }
        } catch (error) { cleanup(); reject(error) }
      }, 500)
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Interactive preflight timed out; inspect ${work}`)) }, 120_000)
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted)
    })
    if (before !== digest(path.join(work, 'app'))) throw new Error('Interactive preflight changed application files')
    json(path.join(work, 'verdict.json'), { passed: true, localPythonRead: true, privateReadsDenied: true, settingsWriteDenied: true })
  } finally {
    signalProcessTree(pty, 'SIGKILL', { detachedProcessGroup: true })
    output.dispose()
    json(path.join(work, 'usage.json'), captureAttemptSessions('claude', runDir, startedAt, work, pin, { agent: 'claude', sessionId, logPath }))
  }
  return path.relative(manifest.root, work)
}
