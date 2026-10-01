import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { commandAvailable } from './command-available'

vi.mock('child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset() })

describe('command availability', () => {
  it.each([['win32', 'where'], ['darwin', 'which'], ['linux', 'which']] as const)(
    'uses the platform lookup on %s', (platform, lookup) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      expect(commandAvailable('codex')).toBe(true)
      expect(execFileSync).toHaveBeenCalledWith(lookup, ['codex'], { stdio: 'ignore' })
    },
  )

  it('treats lookup failures as unavailable', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found') })
    expect(commandAvailable('missing-agent')).toBe(false)
  })
})
