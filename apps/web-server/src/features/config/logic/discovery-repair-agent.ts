import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../agent-sessions/logic/agent-process'
import { agentActivityPath } from '../../agent-sessions/logic/agent-producer'
import { agentModelArgs } from '../../agent-sessions/logic/agent-models'
import { internalAgentContextArgs } from '../../agent-sessions/logic/agent-context-policy'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { resolveStageChoice } from '../../../../../../shared/agent-models'
import type { DiscoveryRepair } from '../../../../../../shared/discovery-repair'
import { loadFeatures } from '../../../shared/feature-loader'

export async function runDiscoveryRepairAgent(
  repair: DiscoveryRepair,
  projectRoot: string,
  onSession: (ref: NonNullable<DiscoveryRepair['sessionRef']>) => void,
): Promise<void> {
  if (repair.owner.kind !== 'internal') throw new Error('An external repair cannot spawn an internal agent')
  const agent = repair.owner.agent
  const prompt = fs.readFileSync(repair.promptPath, 'utf8')
  const sessionId = agent === 'claude' ? crypto.randomUUID() : ''
  const config = loadProjectConfig(projectRoot)
  const choice = resolveStageChoice(agent, config.agentModels, 'heal', null)
  const cwd = path.dirname(repair.promptPath)
  const feature = loadFeatures(path.dirname(repair.featureDir)).find((f) => f.name === repair.feature)
  const directories = [...new Set([projectRoot, repair.featureDir, ...(feature?.repos ?? []).map((repo) => repo.localPath)])]
    .filter((directory) => fs.existsSync(directory))
  const directoryArgs = directories.flatMap((directory) => ['--add-dir', directory])
  onSession({ agent, sessionId })
  const logPath = path.join(path.dirname(repair.promptPath), 'agent-output.log')
  const handle = runAgentProcess({
    command: agent,
    args: agent === 'claude'
      ? [...buildClaudeAgenticArgs(prompt, { ...choice, sessionId }), ...directoryArgs]
      : ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...directoryArgs, ...internalAgentContextArgs(agent), ...agentModelArgs(agent, choice), '-'],
    // A unique cwd also lets the canonical Codex locator identify this repair
    // without confusing it with another agent in the same workspace.
    cwd,
    stdin: agent === 'codex' ? prompt : undefined,
    onChunk: (text) => fs.appendFileSync(logPath, text),
    captureStdout: false,
    idleMs: 10 * 60_000,
    activityPath: agentActivityPath(agent, cwd, sessionId, logPath),
    spawnScope: path.dirname(repair.promptPath),
  })
  const result = await handle.done
  if (result.code !== 0 || result.stopped) throw new Error(`Repair agent stopped (${result.signal ?? result.code ?? 'unknown exit'}). Review its activity before retrying.`)
}
