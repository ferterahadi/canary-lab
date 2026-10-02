import { ChildProcess } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentProcess, CLAUDE_READ_ONLY_TOOLS } from './agent-process'
import { runCommitMessageAgent } from '../../runs/logic/pr/commit-message-agent'
import { runEvaluationAgent } from '../../evaluation/logic/test-review/rewrite-agent'
import { summarizePrd } from '../../coverage/logic/coverage/prd-summary'
import { proposeCoverageMappings } from '../../coverage/logic/coverage/annotate-engine'
import type { HealAgent } from './agent-binary'

vi.mock('./agent-process', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-process')>(),
  runAgentProcess: vi.fn(),
}))

const requirements = [{ id: 'R1', title: 'Add items', text: 'Add item prices', pathTypes: ['happy' as const] }]
const output = JSON.stringify({
  requirements,
  mappings: [{ testName: 'adds items', requirements: ['R1'], pathTypes: ['happy'], confidence: 1 }],
  unmappable: [],
})

beforeEach(() => {
  vi.mocked(runAgentProcess).mockReset().mockReturnValue({
    child: new ChildProcess(), stop: vi.fn(),
    done: Promise.resolve({ code: 0, signal: null, stdout: output, stderr: '' }),
  })
})

const adapters = [
  { name: 'commit message', schema: 'fix-commit-message.schema.json', run: (agent: HealAgent) => runCommitMessageAgent(agent, 'Describe patch') },
  { name: 'evaluation', schema: 'evaluation-rewrite.schema.json', run: (agent: HealAgent) => runEvaluationAgent(agent, 'Rewrite evaluation') },
  { name: 'requirements', schema: 'prd-summary.schema.json', run: (agent: HealAgent) => summarizePrd({
    collection: { docsDir: '/tmp/read-only-parity/docs', entries: [{ relPath: 'requirements.md', content: '# Add items\nAdd item prices' }], docsHash: 'fixture' },
  }, { resolveAgents: () => [agent] }) },
  { name: 'coverage', schema: 'coverage-annotate.schema.json', run: (agent: HealAgent) => proposeCoverageMappings({
    requirements, tests: [{ name: 'adds items' }],
  }, { resolveAgents: () => [agent] }) },
]

// Capture the real adapter arguments: a source-text check would miss a helper
// called incorrectly, or fail simply because the permission flags moved there.
describe.each(adapters)('$name read-only launch', ({ schema, run }) => {
  it('launches Codex with a read-only sandbox, answer file and feature schema', async () => {
    await run('codex')
    expect(runAgentProcess).toHaveBeenCalledTimes(1)
    const launch = vi.mocked(runAgentProcess).mock.calls[0][0]
    expect(launch.command).toBe('codex')
    expect(launch.stdin).toBeTruthy()
    expect(launch.args).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--output-last-message', expect.stringMatching(/\/last-message\.txt$/),
      '--output-schema', expect.stringContaining(schema), '-',
    ])
  })

  it('keeps Claude tools read-only and user MCP servers disabled', async () => {
    await run('claude')
    expect(runAgentProcess).toHaveBeenCalledTimes(1)
    const launch = vi.mocked(runAgentProcess).mock.calls[0][0]
    expect(launch.command).toBe('claude')
    const toolsIndex = launch.args.indexOf('--tools')
    expect(toolsIndex).toBeGreaterThan(-1)
    expect(launch.args[toolsIndex + 1]).toBe(CLAUDE_READ_ONLY_TOOLS.join(','))
    expect(launch.args).toContain('--strict-mcp-config')
  })
})
