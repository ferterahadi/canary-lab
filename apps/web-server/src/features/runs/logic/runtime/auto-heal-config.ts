import path from 'path'
import { buildOrchestratorHealPrompt, type OrchestratorAutoHealFactoryOptions } from './auto-heal'
import { makeAgentSpawnCommandBuilder, type AgentSpawnCommandDefaults } from './heal-agent-spawn'
import type { AutoHealConfig } from './run-orchestrator-types'

type AutoHealConfigOptions = Pick<OrchestratorAutoHealFactoryOptions, 'agent' | 'projectRoot' | 'runDir' | 'personalWikiPath'>
  & Pick<AgentSpawnCommandDefaults, 'binaryPath' | 'models'>

/** Callers retain their launch/restart failure policy; prompt loading stays eager. */
export function createAutoHealConfig({ agent, projectRoot, runDir, personalWikiPath, ...spawnDefaults }: AutoHealConfigOptions): AutoHealConfig {
  return {
    agent,
    buildSpawnCommand: makeAgentSpawnCommandBuilder(agent, {
      mcpConfigFile: path.join(runDir, 'mcp-config.json'), ...spawnDefaults,
    }),
    buildCyclePrompt: buildOrchestratorHealPrompt({ agent, projectRoot, runDir, personalWikiPath }),
  }
}
