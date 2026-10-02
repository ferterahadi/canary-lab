import { describe, expect, it } from 'vitest'
import { buildReadOnlyCodexArgs } from './agent-read-only-args'

const prefix = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only']
const defaults = { model: null, effort: null }

describe('buildReadOnlyCodexArgs', () => {
  it.each(['-', 'Read the supplied patch'])('preserves prompt input %j with CLI model defaults', (prompt) => {
    expect(buildReadOnlyCodexArgs({ prompt, models: defaults })).toEqual([...prefix, prompt])
  })

  it('preserves model, effort, schema and output argument order without shell quoting', () => {
    expect(buildReadOnlyCodexArgs({
      prompt: '-', models: { model: 'test-model', effort: 'high' },
      outputPath: '/tmp/answer directory/result.txt', outputSchemaPath: '/tmp/schema directory/result.json',
    })).toEqual([
      ...prefix, '--model', 'test-model', '-c', 'model_reasoning_effort=high',
      '--output-last-message', '/tmp/answer directory/result.txt',
      '--output-schema', '/tmp/schema directory/result.json', '-',
    ])
  })

  it.each([
    { outputPath: '', outputSchemaPath: '', expected: [] },
    { outputPath: '/tmp/result', expected: ['--output-last-message', '/tmp/result'] },
    { outputSchemaPath: '/tmp/schema', expected: ['--output-schema', '/tmp/schema'] },
  ])('includes only nonempty optional arguments: $expected', ({ expected, ...paths }) => {
    expect(buildReadOnlyCodexArgs({ prompt: '-', models: defaults, ...paths })).toEqual([...prefix, ...expected, '-'])
  })
})
