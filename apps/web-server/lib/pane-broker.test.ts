import { describe, it, expect } from 'vitest'
import { PaneBroker, type PaneMessage, type PaneSubscriber } from './pane-broker'

function recorder(): PaneSubscriber & { msgs: PaneMessage[]; closed: boolean } {
  const msgs: PaneMessage[] = []
  let closed = false
  return {
    msgs,
    get closed() { return closed },
    send: (m) => { msgs.push(m) },
    close: () => { closed = true },
  } as PaneSubscriber & { msgs: PaneMessage[]; closed: boolean }
}

describe('PaneBroker', () => {
  it('replays buffered output on subscribe', () => {
    const b = new PaneBroker(1024)
    b.push('service:api', 'hello')
    b.push('service:api', ' world')
    const r = recorder()
    b.subscribe('service:api', r)
    expect(r.msgs).toEqual([{ type: 'data', chunk: 'hello world' }])
  })

  it('forwards live data to all current subscribers', () => {
    const b = new PaneBroker(1024)
    const a = recorder()
    const c = recorder()
    b.subscribe('playwright', a)
    b.subscribe('playwright', c)
    b.push('playwright', 'PASS')
    expect(a.msgs.at(-1)).toEqual({ type: 'data', chunk: 'PASS' })
    expect(c.msgs.at(-1)).toEqual({ type: 'data', chunk: 'PASS' })
    expect(b.subscriberCount('playwright')).toBe(2)
  })

  it('on exit, sends exit msg to subs and closes them', () => {
    const b = new PaneBroker()
    const r = recorder()
    b.subscribe('agent', r)
    b.markExit('agent', 0)
    expect(r.msgs.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect(r.closed).toBe(true)
  })

  it('subscribing after exit replays + closes immediately', () => {
    const b = new PaneBroker()
    b.push('agent', 'final output')
    b.markExit('agent', 1)
    const r = recorder()
    b.subscribe('agent', r)
    expect(r.msgs).toEqual([
      { type: 'data', chunk: 'final output' },
      { type: 'exit', code: 1 },
    ])
    expect(r.closed).toBe(true)
  })

  it('unsubscribe removes the subscriber from the live set', () => {
    const b = new PaneBroker()
    const r = recorder()
    const off = b.subscribe('playwright', r)
    off()
    b.push('playwright', 'after')
    expect(r.msgs.find((m) => m.type === 'data' && m.chunk === 'after')).toBeUndefined()
  })

  it('paneIds returns all live ids', () => {
    const b = new PaneBroker()
    b.push('service:a', 'x')
    b.push('agent', 'y')
    expect(b.paneIds().sort()).toEqual(['agent', 'service:a'])
  })

  it('snapshot peeks the buffer for a pane', () => {
    const b = new PaneBroker()
    b.push('x', 'abc')
    expect(b.snapshot('x')).toBe('abc')
  })

  it('destroy closes all subs and clears state', () => {
    const b = new PaneBroker()
    const r = recorder()
    b.subscribe('s', r)
    b.destroy()
    expect(r.closed).toBe(true)
    expect(b.paneIds()).toEqual([])
  })

  it('subscriberCount returns 0 for unknown pane', () => {
    const b = new PaneBroker()
    expect(b.subscriberCount('nope')).toBe(0)
  })

  it('resetPane clears buffer and closes subscribers', () => {
    const b = new PaneBroker()
    b.push('x', 'first')
    const r = recorder()
    b.subscribe('x', r)
    b.resetPane('x')
    expect(r.closed).toBe(true)
    expect(b.snapshot('x')).toBe('')
    // Subscribing again starts from a clean slate.
    const r2 = recorder()
    b.subscribe('x', r2)
    expect(r2.msgs).toEqual([])
  })

  it('resetPane on unknown pane is a no-op', () => {
    const b = new PaneBroker()
    expect(() => b.resetPane('missing')).not.toThrow()
  })

  it('after-exit subscribe path returns a no-op unsubscribe', () => {
    const b = new PaneBroker()
    b.markExit('p', 0)
    const r = recorder()
    const off = b.subscribe('p', r)
    expect(() => off()).not.toThrow()
  })
})
