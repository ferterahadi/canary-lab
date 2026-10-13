import type { Client } from '@modelcontextprotocol/client'

// Decoding stays with each diagnostic: doctor reads the first text block,
// while saved-registration verification joins all text blocks.
export async function probeCoverageCommandDiscovery<T>(
  callTool: (request: Parameters<Client['callTool']>[0]) => Promise<T>,
  readText: (result: T) => string,
): Promise<boolean> {
  const result = await callTool({
    name: 'exec',
    arguments: { command: 'search_tools', arguments: { query: 'get_feature_coverage' } },
  })
  const parsed = JSON.parse(readText(result)) as { matches?: Array<{ command?: unknown }> }
  return parsed.matches?.some((match) => match.command === 'get_feature_coverage') ?? false
}
