import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { sameWorkspacePath } from './workspace-path'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', platform))

describe('sameWorkspacePath', () => {
  it.each(['win32', 'linux', 'darwin'])('normalizes lexical paths on %s', (value) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
    expect(sameWorkspacePath(path.join('workspace', 'child', '..', 'repo'), path.join('workspace', 'repo'))).toBe(true)
    expect(sameWorkspacePath('workspace/one', 'workspace/two')).toBe(false)
    expect(sameWorkspacePath('repo', path.resolve('repo'))).toBe(false)
    expect(sameWorkspacePath('~/repo', 'repo')).toBe(false)
  })

  it.each(['win32', 'linux', 'darwin'])('folds case only on Windows (%s)', (value) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
    expect(sameWorkspacePath('Workspace/Repo', 'workspace/repo')).toBe(value === 'win32')
  })
})
