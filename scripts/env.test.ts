import { describe, expect, it, vi } from 'vitest'

const switchEnv = vi.fn(async () => {})

vi.mock('../apps/web-server/lib/runtime/env-switcher/switch', () => ({ main: switchEnv }))

const { main } = await import('./env')

describe('canary-lab env', () => {
  it('applies an envset non-interactively', async () => {
    await main(['apply', 'demo', 'local'])
    expect(switchEnv).toHaveBeenCalledWith(['demo', '--apply', 'local'])
  })

  it('reverts an envset non-interactively', async () => {
    await main(['revert', 'demo'])
    expect(switchEnv).toHaveBeenCalledWith(['demo', '--revert'])
  })
})
