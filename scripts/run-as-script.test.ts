import { describe, it, expect, vi } from 'vitest'
import { runAsScript } from './run-as-script'

describe('runAsScript', () => {
  it('does not invoke main when meta is not require.main', () => {
    const main = vi.fn(async () => {})
    runAsScript({} as NodeModule, main)
    expect(main).not.toHaveBeenCalled()
  })

  it('invokes main when meta equals require.main', async () => {
    const main = vi.fn(async () => {})
    runAsScript(require.main as NodeModule, main)
    expect(main).toHaveBeenCalledTimes(1)
    // allow any pending microtasks from main() to settle
    await Promise.resolve()
  })

  it('logs the error and exits 1 when main rejects', async () => {
    const err = new Error('boom')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // don't actually exit; swallow
      return undefined as never
    }) as never)

    runAsScript(require.main as NodeModule, async () => {
      throw err
    })

    // Wait for the promise chain in runAsScript to settle.
    await new Promise((r) => setImmediate(r))

    expect(errSpy).toHaveBeenCalledWith(err)
    expect(exitSpy).toHaveBeenCalledWith(1)

    errSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
