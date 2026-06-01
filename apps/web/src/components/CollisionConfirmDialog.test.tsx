// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoCollisionChoice } from '../api/client'
import { CollisionConfirmDialog } from './CollisionConfirmDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const info: RepoCollisionChoice = {
  type: 'repo_collision_requires_choice',
  conflictingRunId: 'other-1',
  conflictingFeature: 'broken_todo_api',
  repoPaths: ['/repos/broken_todo_api'],
  options: ['worktree', 'queue'],
  message: 'collision',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button not found: ${label}`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('CollisionConfirmDialog', () => {
  it('names the conflicting feature and offers both choices', async () => {
    await act(async () => {
      root.render(<CollisionConfirmDialog info={info} feature="broken_todo_api" onChoose={() => {}} onCancel={() => {}} />)
    })
    const text = container.textContent ?? ''
    expect(text).toContain('broken_todo_api')
    expect([...container.querySelectorAll('button')].map((b) => b.textContent?.trim()))
      .toEqual(expect.arrayContaining(['Cancel', 'Queue', 'Run isolated (worktree)']))
  })

  it('fires onChoose with worktree and queue', async () => {
    const onChoose = vi.fn()
    await act(async () => {
      root.render(<CollisionConfirmDialog info={info} feature="broken_todo_api" onChoose={onChoose} onCancel={() => {}} />)
    })
    await act(async () => clickButton('Run isolated (worktree)'))
    expect(onChoose).toHaveBeenCalledWith('worktree')
    await act(async () => clickButton('Queue'))
    expect(onChoose).toHaveBeenCalledWith('queue')
  })

  it('fires onCancel from the Cancel button', async () => {
    const onCancel = vi.fn()
    await act(async () => {
      root.render(<CollisionConfirmDialog info={info} feature="x" onChoose={() => {}} onCancel={onCancel} />)
    })
    await act(async () => clickButton('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })
})
