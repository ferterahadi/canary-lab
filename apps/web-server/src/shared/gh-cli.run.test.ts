import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

// `runGh` is the one part of this module that shells out; every other export
// takes an injected runner. Faking execFile is the only way to pin its exit-code
// mapping and the spawn-failure path (gh not on PATH) without a real gh.
const cpMocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: cpMocks.execFile,
}))

const { runGh } = await import('./gh-cli')

type Cb = (error: unknown, stdout: string, stderr: string) => void

/** execFile that invokes its callback with the given triple. */
function execFileYielding(error: unknown, stdout = '', stderr = ''): void {
  cpMocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Cb) => {
    const child = new EventEmitter()
    setImmediate(() => cb(error, stdout, stderr))
    return child
  })
}

beforeEach(() => {
  cpMocks.execFile.mockReset()
})

describe('runGh', () => {
  it('reports code 0 and both streams on success', async () => {
    execFileYielding(null, 'true\n', '')
    await expect(runGh(['api', 'repos/o/r'])).resolves.toEqual({ code: 0, stdout: 'true\n', stderr: '' })
    expect(cpMocks.execFile).toHaveBeenCalledWith('gh', ['api', 'repos/o/r'], { timeout: 15_000 }, expect.any(Function))
  })

  it("passes gh's own exit code through when the error carries one", async () => {
    execFileYielding(Object.assign(new Error('exit 4'), { code: 4 }), '', 'gh: Not Found\n')
    await expect(runGh(['api', 'x'])).resolves.toEqual({ code: 4, stdout: '', stderr: 'gh: Not Found\n' })
  })

  it('normalizes a code-less failure (e.g. a timeout kill) to 1', async () => {
    execFileYielding(Object.assign(new Error('killed'), { signal: 'SIGTERM' }), '', 'timed out')
    await expect(runGh(['api', 'x'])).resolves.toEqual({ code: 1, stdout: '', stderr: 'timed out' })
  })

  it('reports 127 with the spawn error when gh is not on PATH', async () => {
    cpMocks.execFile.mockImplementation(() => {
      const child = new EventEmitter()
      // No callback: a spawn failure surfaces on the child's `error` event.
      setImmediate(() => child.emit('error', new Error('spawn gh ENOENT')))
      return child
    })
    await expect(runGh(['auth', 'status'])).resolves.toEqual({ code: 127, stdout: '', stderr: 'spawn gh ENOENT' })
  })
})
