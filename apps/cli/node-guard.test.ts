import { describe, it, expect } from 'vitest'
import { assertSupportedNode } from './node-guard'

describe('cli node guard', () => {
  it('passes a supported Node without touching exit', () => {
    let exited: number | null = null
    expect(assertSupportedNode('22.12.0', { exit: (c) => { exited = c } })).toBe(true)
    expect(exited).toBeNull()
  })

  it('prints why and exits 1 on an unsupported Node', () => {
    const errors: string[] = []
    let exited: number | null = null

    expect(assertSupportedNode('20.19.0', {
      error: (m) => errors.push(m),
      exit: (c) => { exited = c },
    })).toBe(false)

    expect(exited).toBe(1)
    expect(errors.join('\n')).toContain('needs Node 22.12.0 or newer')
    // The install succeeding is the confusing part; the message has to own it.
    expect(errors.join('\n')).toContain('npm only warns')
  })

  it('reads the running Node when no version is passed', () => {
    // The load-time call takes this path. Vitest runs on a supported Node, so
    // the only observable is that it agrees with the version it is running on.
    expect(assertSupportedNode()).toBe(true)
  })
})
