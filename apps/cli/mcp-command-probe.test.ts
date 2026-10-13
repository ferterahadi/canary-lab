import { expect, it, vi } from 'vitest'
import { probeCoverageCommandDiscovery } from './mcp-command-probe'

it.each([
  ['{"matches":[{"command":"get_feature_coverage"}]}', true],
  ['{"matches":[{"command":"other"},{"command":"get_feature_coverage"}]}', true],
  ['{"matches":[{"command":"other"},{"command":null},{}]}', false],
  ['{"matches":[]}', false],
  ['{}', false],
] as const)('checks the discovery result %s', async (text, expected) => {
  const response = { text }
  const callTool = vi.fn(async () => response)
  const readText = vi.fn((result: typeof response) => result.text)
  expect(await probeCoverageCommandDiscovery(callTool, readText)).toBe(expected)
  expect(callTool).toHaveBeenCalledExactlyOnceWith({ name: 'exec', arguments: { command: 'search_tools', arguments: { query: 'get_feature_coverage' } } })
  expect(readText).toHaveBeenCalledExactlyOnceWith(response)
})

it('propagates malformed JSON', async () => {
  await expect(probeCoverageCommandDiscovery(async () => 'invalid', (text) => text)).rejects.toBeInstanceOf(SyntaxError)
})

it('propagates transport and decoder failures unchanged', async () => {
  const failure = new Error('original failure')
  const readText = vi.fn(() => '')
  await expect(probeCoverageCommandDiscovery(async () => { throw failure }, readText)).rejects.toBe(failure)
  expect(readText).not.toHaveBeenCalled()
  await expect(probeCoverageCommandDiscovery(async () => 'value', () => { throw failure })).rejects.toBe(failure)
})
