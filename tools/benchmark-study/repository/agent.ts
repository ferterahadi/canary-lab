import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn, type SpawnOptions } from 'node:child_process'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../apps/web-server/src/features/agent-sessions/logic/agent-process'
import { agentModelArgs } from '../../../apps/web-server/src/features/agent-sessions/logic/agent-models'
import { signalProcessTree } from '../../../apps/web-server/src/shared/process-tree'
import { captureExecutionEvidence, pinnedClaudeSessionRef } from '../agents'
import { prepareNativeIsolation } from '../isolation'
import { claudePermissionArgs, REPAIR_ALLOWED_TOOLS } from '../claude-permissions'
import { command, changed, hashes, json, sha, write } from '../files'
import { runtimeEnvironment } from '../runtime'
import { verifyCodexToolArgs } from '../tool-policy'
import type { Attempt, ExecutionResult, StudyManifest } from '../types'
import { assertRepositoryAuthorization } from './campaign'
import { startRepositoryCheckBroker } from './check-broker'
import { renderRepositoryRepairPrompt } from './prompts'
import { reviewCodexChildContext } from './child-context'
import { prepareChildAudit, reviewChildAudit } from './child-audit'
import { childReadGuard, installClaudeChildReadGuard, reviewChildReadGuard } from './child-read-guard'

export async function runRepositoryAgent(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal, telemetryArgs: string[] = []): Promise<ExecutionResult> {
  assertRepositoryAuthorization(manifest)
  const repository = manifest.repository!
  const replay = manifest.design?.mode === 'replay'
  const audit = !replay && attempt.agent === 'codex' ? prepareChildAudit(manifest, attempt, root) : undefined
  const previousHome = process.env.CODEX_HOME
  if (audit) process.env.CODEX_HOME = audit.home
  if (audit) await verifyCodexToolArgs(audit.args, root, manifest.pins.codex.executable)
  const native = replay ? undefined : await prepareNativeIsolation(manifest.root, root, 'canary', attempt.agent, manifest.pins.codex.executable,
    [repository.fixtureRoot, repository.sourceCheckout, path.join(os.homedir(), '.colima'), ...(audit ? [repository.childAudit!.authFile] : [])])
  // Codex registers the same guard in its isolated audit home.
  if (native && attempt.agent === 'claude') installClaudeChildReadGuard(native.claudeSettings, childReadGuard(manifest, attempt, root).hooks)
  const policy = attempt.variant?.diagnosisPolicy ?? (attempt.workflow === 'plain' ? 'parent-only' : 'per-failure')
  const prompt = renderRepositoryRepairPrompt(manifest, attempt)
  write(path.join(root, 'prompt.md'), prompt)
  json(path.join(root, 'prompt-receipt.json'), { digest: sha(prompt), diagnosisPolicy: policy, bytes: Buffer.byteLength(prompt) })
  const broker = await startRepositoryCheckBroker(manifest, attempt, root, signal)
  try {
    if (replay) {
      // A scripted repair is a plumbing control, never evidence that a model
      // diagnosed the defect. Only source deltas from the frozen clean control
      // are applied; the independent evaluator still runs afterward.
      const check = async (): Promise<string> => {
        const result = await command(process.execPath, [path.join(root, 'check.cjs')], { cwd: root, signal,
          timeoutMs: manifest.budgetMs, log: path.join(root, 'scripted-checks.log') })
        if (result.code !== 0) throw new Error('Scripted repository check failed')
        return JSON.parse(result.stdout).status
      }
      if (await check() !== 'failed') throw new Error('Scripted replay did not observe its expected defect')
      const broken = path.join(manifest.root, 'attempts', attempt.scenario, 'source')
      const clean = path.join(manifest.root, 'attempts/clean/source')
      for (const file of changed(hashes(broken), hashes(clean)).filter((name) => name.startsWith('src/'))) {
        copySourceFile(clean, path.join(root, 'app'), file)
      }
      const passed = await check() === 'passed'
      return { status: signal.aborted ? 'interrupted' : passed ? 'finished' : 'infrastructure-error', reason: 'Scripted repository replay (no model)',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, testExecutions: broker.executions(),
        telemetry: { status: 'not-applicable', requestEvents: 0, errorEvents: 0, retryEvents: 0, requestDurationMs: 0,
          streamDurationMs: 0, toolDurationMs: null, rejectedBatches: 0 } }
    }
    const pin = manifest.pins[attempt.agent]
    const sessionId = randomUUID()
    const startedAt = new Date().toISOString()
    const args = attempt.agent === 'claude'
      ? [...buildClaudeAgenticArgs(prompt, { ...pin, sessionId }).filter((arg) => arg !== '--dangerously-skip-permissions'),
        ...claudePermissionArgs(REPAIR_ALLOWED_TOOLS), '--strict-mcp-config', '--setting-sources', '', '--settings', native!.claudeSettings]
      : ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', ...agentModelArgs('codex', pin), ...(audit?.args ?? manifest.codexToolArgs ?? []), ...telemetryArgs, ...native!.codexArgs, prompt]
    const stream = path.join(root, 'agent-output.jsonl')
    const handle = runAgentProcess({ command: attempt.agent, args, cwd: root, idleMs: manifest.budgetMs, captureStdout: false,
      resolveBinary: () => pin.executable ?? null, activityPath: stream, onChunk: (chunk) => fs.appendFileSync(stream, chunk),
      spawnImpl: ((cmd: string, argv: readonly string[], options: SpawnOptions) => spawn(cmd, argv,
        { ...options, env: { ...options.env, ...runtimeEnvironment(root) } })) as typeof spawn })
    const stop = (): void => handle.stop('SIGTERM')
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    try {
      const result = await handle.done
      const ref = attempt.agent === 'claude' ? pinnedClaudeSessionRef(root, sessionId) : null
      const evidence = captureExecutionEvidence(manifest, attempt, root, startedAt, root, ref)
      if (attempt.agent === 'codex' && evidence.adherence) {
        evidence.adherence = reviewCodexChildContext(root, pin, evidence.attribution, evidence.adherence, repository.childAudit?.backend, audit?.output)
        evidence.adherence = reviewChildAudit(manifest, attempt, root, evidence.attribution, evidence.adherence)
      }
      if (evidence.adherence) {
        evidence.adherence = reviewChildReadGuard(manifest, attempt, root, evidence.adherence)
        json(path.join(root, 'policy-adherence.json'), evidence.adherence)
      }
      return { status: signal.aborted ? 'interrupted' : broker.failure() || result.code !== 0 ? 'infrastructure-error' : 'finished',
        reason: broker.failure() ?? `Repository agent exit: ${result.code}; signal: ${result.signal}`,
        ...evidence, testExecutions: broker.executions() }
    } finally {
      signal.removeEventListener('abort', stop)
      signalProcessTree(handle.child, 'SIGKILL', { detachedProcessGroup: true })
    }
  } finally {
    await broker.close()
    if (audit) { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome }
  }
}

function copySourceFile(source: string, target: string, file: string): void {
  const original = path.join(source, file)
  if (!fs.existsSync(original)) fs.rmSync(path.join(target, file), { force: true })
  else {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true })
    fs.copyFileSync(original, path.join(target, file))
  }
}
