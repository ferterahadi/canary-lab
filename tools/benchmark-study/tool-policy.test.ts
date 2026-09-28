import { beforeEach, expect, it, vi } from 'vitest'
import { checked } from './files'
import { resolveCodexToolArgs, verifyCodexToolArgs } from './tool-policy'

vi.mock('./files', () => ({ checked: vi.fn() }))
beforeEach(() => vi.mocked(checked).mockReset())

it('overrides each inherited server and verifies the effective inventory', async () => {
  vi.mocked(checked).mockResolvedValueOnce('[{"name":"existing-server","enabled":true}]').mockResolvedValueOnce('[{"name":"existing-server","enabled":false}]')
  const args = await resolveCodexToolArgs('/fixture')
  expect(args).toContain('mcp_servers.existing-server.enabled=false')
  expect(args).toContain('plugins')
  expect(checked).toHaveBeenLastCalledWith('codex', [...args, 'mcp', 'list', '--json'], '/fixture')
})

it('fails closed on newly enabled connectors and unsupported inventory names', async () => {
  vi.mocked(checked).mockResolvedValueOnce('[{"name":"new-server","enabled":true}]')
  await expect(verifyCodexToolArgs(['--disable', 'apps'], '/fixture')).rejects.toThrow('remain enabled')
  vi.mocked(checked).mockResolvedValueOnce('[{"name":"dotted.name","enabled":true}]')
  await expect(resolveCodexToolArgs('/fixture')).rejects.toThrow('Cannot safely address')
  await expect(verifyCodexToolArgs(undefined, '/fixture')).rejects.toThrow('prepare a new')
})

it('rejects an unknown CLI inventory shape instead of assuming no tools', async () => {
  vi.mocked(checked).mockResolvedValueOnce('{}')
  await expect(resolveCodexToolArgs('/fixture')).rejects.toThrow('Unexpected Codex MCP inventory')
})

it('uses the frozen executable even when another codex is first on PATH', async () => {
  vi.mocked(checked).mockResolvedValue('[]')
  await resolveCodexToolArgs('/fixture', '/pinned/cli/codex')
  expect(vi.mocked(checked).mock.calls.every(([executable]) => executable === '/pinned/cli/codex')).toBe(true)
})
