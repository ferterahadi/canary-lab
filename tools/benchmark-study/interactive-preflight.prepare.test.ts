import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { StudyManifest } from './types'
import { quote } from './files'

vi.mock('./isolation', () => ({
  prepareNativeIsolation: vi.fn(async (_root: string, work: string) => {
    const settings = path.join(work, 'agent-isolation.json')
    fs.writeFileSync(settings, '{}')
    return { codexArgs: [], claudeSettings: settings }
  }),
}))
vi.mock('../../apps/web-server/src/features/runs/logic/runtime/pty-spawner', () => ({
  realPtyFactory: vi.fn(() => { throw new Error('preparation must not start a PTY') }),
}))
vi.mock('../../apps/web-server/src/features/agent-sessions/logic/agent-workspace-trust', () => ({
  ensureClaudeWorkspaceTrusted: vi.fn(() => { throw new Error('preparation must not modify trust') }),
}))

it('prepares an exact supervised probe packet without launching Claude or changing trust', async () => {
  const { prepareInteractivePreflight } = await import('./interactive-preflight')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervised-probe-'))
  try {
    const frozen = path.join(root, 'frozen/single-service')
    fs.mkdirSync(path.join(frozen, 'shared'), { recursive: true })
    fs.mkdirSync(path.join(root, 'attempts'))
    fs.mkdirSync(path.join(root, 'runtime'))
    fs.writeFileSync(path.join(root, 'study.json'), '{"kind":"synthetic-diagnostic"}')
    fs.writeFileSync(path.join(frozen, 'shared/durable.ts'), 'export const synthetic = true\n')
    fs.writeFileSync(path.join(frozen, 'REQUIREMENTS.md'), '# Synthetic storefront\n')
    const pins: StudyManifest['pins'] = {
      codex: { model: 'fixture', effort: 'high', executable: '/bin/echo', version: 'fixture' },
      claude: { model: 'claude-opus-5-5', effort: 'high', executable: '/bin/echo', version: 'fixture' },
    }
    const packet = await prepareInteractivePreflight({ root, pins })
    expect(fs.existsSync(path.join(packet.work, 'app/shared/durable.ts'))).toBe(true)
    expect(fs.existsSync(path.join(packet.work, 'agent-isolation.json'))).toBe(true)
    expect(fs.existsSync(path.join(packet.work, 'denial-probe.sh'))).toBe(true)
    expect(fs.existsSync(path.join(packet.work, 'interactive-probe.sh'))).toBe(true)
    expect(fs.existsSync(path.join(packet.runDir, 'prompt.md'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(packet.runDir, 'e2e-summary.json'), 'utf8'))).toEqual({ probe: 'local-summary' })
    expect(JSON.parse(fs.readFileSync(path.join(packet.work, 'invocation.json'), 'utf8'))).toMatchObject({
      cwd: packet.runDir, sessionId: packet.sessionId, marker: packet.marker, timeoutMs: 120_000,
    })
    expect(packet.spawnCommand).toContain("'--permission-mode' 'dontAsk'")
    expect(packet.spawnCommand).toContain(`'--allowedTools' ${quote(`Bash(${packet.command})`)}`)
    expect(packet.spawnCommand).toContain('--setting-sources ""')
    expect(packet.spawnCommand).toContain('--strict-mcp-config')
    expect(fs.existsSync(path.join(packet.work, 'agent-terminal.log'))).toBe(false)
    expect(fs.existsSync(path.join(packet.work, 'usage.json'))).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
