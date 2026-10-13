import { afterEach, expect, it, vi } from 'vitest'
import { createAutoHealConfig } from './auto-heal-config'
import path from 'path'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('heal-config-')
afterEach(() => vi.unstubAllEnvs())

it('binds the run configuration while forwarding per-cycle spawn inputs', () => {
  vi.stubEnv('CANARY_LAB_HEAL_MODEL', '')
  const runDir = tempDir()
  const config = createAutoHealConfig({
    agent: 'claude', projectRoot: runDir, runDir,
    binaryPath: '/opt/agent/claude', models: { model: 'opus', effort: 'high' },
  })
  const command = config.buildSpawnCommand!({
    sessionId: 'session-1', promptFile: path.join(runDir, 'heal-prompt.md'),
    mcpOutputDir: path.join(runDir, 'playwright-mcp'),
    writableDirs: ['/repos/shop'], readableDirs: ['/reference'],
  })
  expect(config.agent).toBe('claude')
  expect(command).toContain('/opt/agent/claude')
  expect(command).toContain(path.join(runDir, 'mcp-config.json'))
  expect(command).toContain('--model "opus"')
  expect(command).toContain('"--effort" "high"')
  expect(command).toContain('session-1')
  expect(command).toContain('/repos/shop')
  expect(command).toContain('/reference')
  expect(command).toContain(path.join(runDir, 'heal-prompt.md'))
})
