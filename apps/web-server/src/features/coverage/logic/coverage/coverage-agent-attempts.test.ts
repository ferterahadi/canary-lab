import { describe, expect, it, vi } from 'vitest'
import { AGENT_DEFAULT_CHOICE } from '../../../../../../../shared/agent-models'
import { runCoverageAgentAttempts } from './coverage-agent-attempts'

type Options = Parameters<typeof runCoverageAgentAttempts<string[]>>[0]

function options(overrides: Partial<Options> = {}): Options {
  return {
    agents: ['claude', 'codex'],
    prompt: 'Read the supplied documents',
    runAgent: vi.fn().mockResolvedValue('answer'),
    validate: () => ({ accepted: true, value: [] }),
    activity: 'reading',
    cancellationMessage: 'reading cancelled',
    failurePrefix: 'Reading failed',
    noAnswerMessage: 'No usable answer',
    ...overrides,
  }
}

it('accepts an empty result and stops after the first usable answer', async () => {
  const config = options()
  await expect(runCoverageAgentAttempts(config)).resolves.toEqual([])
  expect(config.runAgent).toHaveBeenCalledTimes(1)
})

it('falls back after an ordinary failure with each agent’s own launch context', async () => {
  const signal = new AbortController().signal
  const onSession = vi.fn()
  const onOutput = vi.fn()
  const runAgent = vi.fn().mockRejectedValueOnce(new Error('authentication expired')).mockResolvedValueOnce('answer')
  const models = { claude: { ...AGENT_DEFAULT_CHOICE, model: 'claude-choice' }, codex: { ...AGENT_DEFAULT_CHOICE, model: 'codex-choice' } }
  const agentJob = { record: { jobId: 'job', agent: 'claude' as const }, logsDir: '/tmp/coverage-attempts' }
  await runCoverageAgentAttempts(options({ runAgent, signal, cwd: '/tmp/docs', spawnScope: 'scope', agentJob, onSession, onOutput, models }))
  expect(runAgent.mock.calls).toEqual(['claude', 'codex'].map((agent) => [agent, 'Read the supplied documents', {
    cwd: '/tmp/docs', signal, spawnScope: 'scope', agentJob, onSession, models: models[agent as keyof typeof models],
  }]))
  expect(onOutput.mock.calls.flat()).toEqual([
    '[agent:claude] reading\n', '[agent:claude] failed: authentication expired\n', '[agent:codex] reading\n',
  ])
})

it('retries a rejected answer and reports the validator’s reason', async () => {
  const onOutput = vi.fn()
  const validate = vi.fn<Options['validate']>()
    .mockReturnValueOnce({ accepted: false, progress: 'incomplete; trying next', failure: 'missing tests' })
    .mockReturnValueOnce({ accepted: true, value: ['complete'] })
  await expect(runCoverageAgentAttempts(options({ validate, onOutput }))).resolves.toEqual(['complete'])
  expect(onOutput).toHaveBeenCalledWith('[agent:claude] incomplete; trying next\n')
})

it.each<{ agents: Options['agents'] }>([{ agents: [] }, { agents: ['claude', 'codex'] }])('reports no usable answer for $agents', async ({ agents }) => {
  await expect(runCoverageAgentAttempts(options({
    agents, validate: () => ({ accepted: false, progress: 'unparseable output; trying next' }),
  }))).rejects.toThrow('No usable answer')
})

it('does not let a later unparseable answer erase an actionable failure', async () => {
  await expect(runCoverageAgentAttempts(options({
    runAgent: vi.fn().mockRejectedValueOnce('authentication expired').mockResolvedValueOnce('garbage'),
    validate: () => ({ accepted: false, progress: 'unparseable output; trying next' }),
  }))).rejects.toThrow('Reading failed: authentication expired')
})

it('retains a validator’s failure reason after exhaustion', async () => {
  await expect(runCoverageAgentAttempts(options({
    validate: () => ({ accepted: false, progress: 'incomplete', failure: 'missing tests' }),
  }))).rejects.toThrow('Reading failed: missing tests')
})

describe('cancellation', () => {
  it('launches nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const config = options({ signal: controller.signal })
    await expect(runCoverageAgentAttempts(config)).rejects.toThrow('Reading failed: reading cancelled')
    expect(config.runAgent).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('waits for an active attempt to %s and never launches fallback after abort', async (outcome) => {
    const controller = new AbortController()
    let resolve!: (value: string) => void
    let reject!: (error: Error) => void
    const runAgent = vi.fn(() => new Promise<string>((yes, no) => { resolve = yes; reject = no }))
    const validate = vi.fn<Options['validate']>(() => ({ accepted: true, value: [] }))
    const pending = runCoverageAgentAttempts(options({ runAgent, validate, signal: controller.signal }))
    const settled = vi.fn()
    const observed = pending.then(settled, settled)
    controller.abort()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    if (outcome === 'resolve') resolve('valid answer arriving after cancellation')
    else reject(new Error('child stopped'))
    await expect(pending).rejects.toThrow('Reading failed: reading cancelled')
    await observed
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(validate).not.toHaveBeenCalled()
  })

  it.each([1, 2])('stops when progress delivery aborts attempt %i', async (abortAt) => {
    const controller = new AbortController()
    let messages = 0
    const config = options({
      signal: controller.signal,
      validate: () => ({ accepted: false, progress: 'try next' }),
      onOutput: () => { if (++messages === abortAt) controller.abort() },
    })
    await expect(runCoverageAgentAttempts(config)).rejects.toThrow('Reading failed: reading cancelled')
    expect(config.runAgent).toHaveBeenCalledTimes(abortAt - 1)
  })

  it('preserves cancellation when the final rejected answer triggers abort', async () => {
    const controller = new AbortController()
    await expect(runCoverageAgentAttempts(options({
      agents: ['claude'], signal: controller.signal,
      validate: () => ({ accepted: false, progress: 'rejected' }),
      onOutput: (text) => { if (text.includes('rejected')) controller.abort() },
    }))).rejects.toThrow('Reading failed: reading cancelled')
  })
})
