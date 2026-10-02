import fs from 'node:fs'
import path from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copy, digest, json, quote, write } from './files'
import { dependencies, parseResults, ports, testEnvironment } from './evaluator'
import { runtimeEnvironment, services, writeRunbook } from './runtime'
import { prepareNativeIsolation } from './isolation'
import { scenarios } from './scenarios'
import { releasePorts } from '../../apps/web-server/src/features/runs/logic/runtime/port-allocator'
import { buildClaudeAgenticArgs, runAgentProcess } from '../../apps/web-server/src/features/agent-sessions/logic/agent-process'
import { loadPromptTemplate } from '../../apps/web-server/src/shared/prompts'
import { listCodexSessionLogs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-session-paths'
import { agentModelArgs } from '../../apps/web-server/src/features/agent-sessions/logic/agent-models'
import { sessionEvidence, pinnedClaudeSessionRef } from './agents'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import { stopAttemptServices } from './cleanup'
import type { StudyManifest } from './types'
import { interactivePreflight } from './interactive-preflight'
import { claudePermissionArgs } from './claude-permissions'

// Exercise the documented shell commands in each native sandbox. Direct Node
// probes missed the blocked PATH entries and IPC socket in the old npm runbook.
export async function runtimePreflight(manifest: StudyManifest): Promise<void> {
  if (manifest.preparation.nativeRuntime) return
  const started = Date.now()
  const evidence = []
  for (const agent of ['codex', 'claude'] as const) {
    if (!manifest.attempts.some((attempt) => attempt.agent === agent)) continue
    const work = path.join(manifest.root, 'attempts', `runtime-preflight-${agent}-${Date.now()}`)
    copy(path.join(manifest.root, 'frozen/single-service'), path.join(work, 'app'))
    copy(path.join(manifest.root, 'frozen/plain-suite'), path.join(work, 'suite'))
    dependencies(work, manifest.root)
    const before = digest(path.join(work, 'app')) + digest(path.join(work, 'suite'))
    const allocated = await ports()
    try {
      const native = await prepareNativeIsolation(manifest.root, work, 'plain', agent, manifest.pins.codex.executable)
      const commands = writeRunbook(work, allocated, testEnvironment(work, allocated))
      const script = [
        'set -eu', 'source ./environment.sh', 'pids=""',
        'trap \'kill $pids 2>/dev/null || true\' EXIT',
        ...commands.start.split('\n').flatMap((line) => [line, 'pids="$pids $!"']),
        ...services.map((name) => `ready=0; for i in {1..100}; do if /usr/bin/curl --fail --silent http://127.0.0.1:${allocated[name]}/ >/dev/null; then ready=1; break; fi; sleep 0.1; done; test "$ready" = 1`),
        'set +e', `PLAYWRIGHT_JSON_OUTPUT_NAME=${quote(path.join(work, 'playwright.json'))} ${commands.test} --reporter=json`,
        'status=$?', 'set -e', 'test "$status" = 1',
        ...[path.join(manifest.root, 'study.json'), path.join(manifest.root, 'runtime/node_modules/canary-lab/package.json')]
          .map((file) => `if /bin/cat ${quote(file)} >/dev/null 2>denial.log; then exit 91; fi; /usr/bin/grep -qi 'operation not permitted' denial.log`),
        'echo NATIVE_RUNTIME_OK',
      ].join('\n') + '\n'
      write(path.join(work, 'runtime-preflight.sh'), script)
      const log = path.join(work, 'native-output.jsonl')
      const sessionId = randomUUID()
      const startedAt = new Date().toISOString()
      const pin = manifest.pins[agent]
      const prompt = loadPromptTemplate(path.join(__dirname, 'runtime-preflight-prompt.md'))
      write(path.join(work, 'prompt.md'), prompt)
      const args = agent === 'claude'
        ? [...buildClaudeAgenticArgs(prompt, { ...pin, sessionId }).filter((arg) => arg !== '--dangerously-skip-permissions'),
          ...claudePermissionArgs(['Bash(/bin/bash ./runtime-preflight.sh)']), '--setting-sources', '', '--settings', native.claudeSettings, '--tools', 'Bash', '--max-turns', '2']
        : ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', ...agentModelArgs('codex', pin), ...(manifest.codexToolArgs ?? []), ...native.codexArgs, prompt]
      const handle = runAgentProcess({ command: agent, args, cwd: work, idleMs: 120_000,
        resolveBinary: () => pin.executable ?? null,
        onChunk: (chunk) => fs.appendFileSync(log, chunk),
        spawnImpl: ((cmd: string, argv: readonly string[], options: SpawnOptions) => spawn(cmd, argv, { ...options, env: { ...options.env, ...runtimeEnvironment(work) } })) as typeof spawn })
      const stop = (): void => handle.stop('SIGTERM')
      const timer = setTimeout(stop, 120_000)
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      try {
        const result = await handle.done
        const ref = agent === 'claude' ? pinnedClaudeSessionRef(work, sessionId) : listCodexSessionLogs(work, startedAt)[0] ?? null
        json(path.join(work, 'usage.json'), sessionEvidence(ref, work, pin))
        const rows = result.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
        const runtimePassed = rows.some((row) => agent === 'codex'
          ? row.type === 'item.completed' && row.item?.type === 'command_execution' && row.item.exit_code === 0 && row.item.aggregated_output?.includes('NATIVE_RUNTIME_OK')
          : row.type === 'user' && row.message?.content?.some((block: { type?: string; content?: unknown }) =>
            block.type === 'tool_result' && typeof block.content === 'string' && block.content.includes('NATIVE_RUNTIME_OK')))
        if (result.code !== 0 || !runtimePassed) throw new Error(`${agent} runtime preflight failed; inspect ${work}`)
      } finally {
        clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
        signalProcessTree(handle.child, 'SIGKILL', { detachedProcessGroup: true })
      }
      if (before !== digest(path.join(work, 'app')) + digest(path.join(work, 'suite'))) throw new Error('Preflight agent changed application or suite')
      const tests = parseResults(JSON.parse(fs.readFileSync(path.join(work, 'playwright.json'), 'utf8')), 1)
      if (tests.roster.length !== 7 || tests.skipped.length ||
        JSON.stringify(tests.failed.map((title) => title.split(' ')[0]).sort()) !== JSON.stringify(scenarios['single-service'].failedJourneys)) {
        throw new Error(`Native service/Playwright preflight failed; inspect ${work}`)
      }
      json(path.join(work, 'verdict.json'), tests)
      evidence.push({ agent, evidence: path.relative(manifest.root, work) })
    } finally {
      try { await stopAttemptServices(work, Object.values(allocated)) }
      finally { releasePorts(Object.values(allocated)) }
    }
  }
  if (manifest.attempts.some((attempt) => attempt.agent === 'claude')) {
    evidence.push({ agent: 'claude' as const, evidence: await interactivePreflight(manifest) })
  }
  manifest.preparation.nativeRuntime = { evidence, elapsedMs: Date.now() - started }
  manifest.preparationMs += Date.now() - started
}
