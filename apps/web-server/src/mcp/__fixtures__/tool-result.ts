import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'

/** Text assertions must not accidentally accept an input-request or image result. */
export function toolResultText(result: CallToolResult | InputRequiredResult): string {
  const content = result.content
  if (result.resultType === 'input_required' || !Array.isArray(content) || content[0]?.type !== 'text' || typeof content[0].text !== 'string') {
    throw new Error('Expected an MCP text result')
  }
  return content[0].text
}
