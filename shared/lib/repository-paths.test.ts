import { expect, it } from 'vitest'
import { distinctRepoPaths } from './repository-paths'

it('retains the first spelling and keeps services and worktrees separate', () => {
  expect(distinctRepoPaths(['/repo/', '/repo', '/repo/service', '/worktree', 'C:\\repo\\', 'C:\\repo'])).toEqual(['/repo/', '/repo/service', '/worktree', 'C:\\repo\\'])
  expect(distinctRepoPaths([])).toEqual([])
  expect(distinctRepoPaths(['~/repo', '/home/example/repo'])).toEqual(['~/repo', '/home/example/repo'])
})
