import { expect, it } from 'vitest'
import { toolResultText } from './__fixtures__/tool-result'

it('preserves text verbatim, including an empty successful result', () => {
  expect(toolResultText({ content: [{ type: 'text', text: '{"ok":true}' }] })).toBe('{"ok":true}')
  expect(toolResultText({ content: [{ type: 'text', text: '' }] })).toBe('')
})

it('fails a text assertion when the tool returns no content or a non-text result', () => {
  expect(() => toolResultText({ content: [] })).toThrow('Expected an MCP text result')
  expect(() => toolResultText({ content: [{ type: 'image', data: '', mimeType: 'image/png' }] })).toThrow('Expected an MCP text result')
})
