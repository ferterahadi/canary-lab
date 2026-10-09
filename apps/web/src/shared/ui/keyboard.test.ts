import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { activateOnKey, blurOnEnter } from './keyboard'

const self = { id: 'self' }
const child = { id: 'child' }

function keyEvent(key: string, target: object = self) {
  return {
    key,
    target,
    currentTarget: self,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

function asKeyboard<T>(e: ReturnType<typeof keyEvent>): KeyboardEvent<T> {
  return e as unknown as KeyboardEvent<T>
}

describe('activateOnKey', () => {
  it.each(['Enter', ' '])('activates on %j and keeps Space from scrolling the page', (key) => {
    const activate = vi.fn()
    const e = keyEvent(key)
    activateOnKey(activate)(asKeyboard(e))
    expect(activate).toHaveBeenCalledWith(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(e.stopPropagation).not.toHaveBeenCalled()
  })

  it('ignores every other key without swallowing it', () => {
    const activate = vi.fn()
    const e = keyEvent('Tab')
    activateOnKey(activate)(asKeyboard(e))
    expect(activate).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('stops propagation only when asked', () => {
    const activate = vi.fn()
    const e = keyEvent('Enter')
    activateOnKey(activate, { stopPropagation: true })(asKeyboard(e))
    expect(activate).toHaveBeenCalledOnce()
    expect(e.stopPropagation).toHaveBeenCalledOnce()
  })

  it('leaves a key bubbling from a child alone when it owns only its own target', () => {
    const activate = vi.fn()
    const bubbled = keyEvent('Enter', child)
    activateOnKey(activate, { ownTargetOnly: true })(asKeyboard(bubbled))
    expect(activate).not.toHaveBeenCalled()
    expect(bubbled.preventDefault).not.toHaveBeenCalled()

    const own = keyEvent('Enter')
    activateOnKey(activate, { ownTargetOnly: true })(asKeyboard(own))
    expect(activate).toHaveBeenCalledOnce()
  })
})

describe('blurOnEnter', () => {
  it('blurs the input on Enter and on no other key', () => {
    const blur = vi.fn()
    const input = { blur }
    blurOnEnter(asKeyboard<HTMLInputElement>(keyEvent('a', input)))
    expect(blur).not.toHaveBeenCalled()
    blurOnEnter(asKeyboard<HTMLInputElement>(keyEvent('Enter', input)))
    expect(blur).toHaveBeenCalledOnce()
  })
})
