import { describe, it, expect, vi, afterEach } from 'vitest'
import { killTree } from './run-spawn'
import type { PtyHandle } from './pty-spawner'

// killTree is the only thing standing between an aborted run and a heal agent
// that outlives it, so both the process-group path and the per-pty fallback are
// pinned here rather than left to a live abort.

const fakePty = (overrides: Partial<PtyHandle> = {}): PtyHandle =>
  ({ pid: 4242, kill: vi.fn(), write: vi.fn(), resize: vi.fn(), ...overrides }) as unknown as PtyHandle

afterEach(() => vi.restoreAllMocks())

describe('killTree', () => {
  it('signals the whole process group and stops there when that works', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty()

    killTree(pty, 'SIGTERM')

    // Negative pid = the group, which is what reaches the shell's children.
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('falls back to the pty when the process group cannot be signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty()

    killTree(pty, 'SIGKILL')

    expect(pty.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('passes no signal to the pty fallback when given a numeric signal', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty()

    killTree(pty, 9)

    // node-pty's kill takes a signal *name*; handing it a number would throw.
    expect(pty.kill).toHaveBeenCalledWith(undefined)
  })

  it('swallows a pty that is already dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty({ kill: vi.fn(() => { throw new Error('already exited') }) })

    expect(() => killTree(pty, 'SIGTERM')).not.toThrow()
  })
})
