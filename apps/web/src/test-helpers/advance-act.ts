import { act } from 'react'
import { vi } from 'vitest'

/** Test scaffolding: advance fake timers by `ms` inside `act()`, so the effects
 *  and state updates those timers trigger have flushed when it resolves.
 *
 *  Returns `act`'s own thenable, unwrapped, so a caller resolves on exactly the
 *  tick it did when the body was inline. The sibling form that returns the
 *  advance promise from the callback (`act(async () => vi.advanceTimersByTimeAsync(ms))`)
 *  settles one microtask later and is deliberately not folded in here. */
export const advanceAct = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
