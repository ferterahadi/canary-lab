import fs from 'node:fs'
import path from 'node:path'
import { canaryRunDir, quote, write } from './files'
import { runCanary, runPlain } from './agents'
import type { Attempt, ExecutionResult, StudyManifest } from './types'

export async function runReplay(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal): Promise<ExecutionResult> {
  fs.copyFileSync(path.join(manifest.root, 'frozen', `replay-${attempt.scenario}.json`), path.join(root, 'replay-patch.json'))
  const agent = path.join(root, 'replay-agent.cjs')
  write(agent, fs.readFileSync(path.join(__dirname, 'replay-agent.cjs'), 'utf8'))
  const args = [agent, root, attempt.workflow, canaryRunDir(root)]
  const result = attempt.workflow === 'canary'
    ? await runCanary(manifest, attempt, root, signal, () => [process.execPath, ...args].map(quote).join(' '))
    : await runPlain(manifest, attempt, root, signal, { command: process.execPath, args })
  return { ...result, reason: `Scripted replay (no model): ${result.reason}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    telemetry: { status: 'not-applicable', requestEvents: 0, errorEvents: 0, retryEvents: 0, requestDurationMs: 0,
      streamDurationMs: 0, toolDurationMs: null, rejectedBatches: 0 } }
}
