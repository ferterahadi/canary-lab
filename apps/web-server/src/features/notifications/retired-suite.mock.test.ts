import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
const { git } = vi.hoisted(() => ({ git: vi.fn() }))
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  return { execFile: Object.assign(() => {}, { [promisify.custom]: git }) }
})
import { isCommittedSuiteRetirement } from './retired-suite'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-git-'))
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })
it('rejects Git evidence whose repository root does not contain the suite', async () => {
  fs.mkdirSync(path.join(dir, 'features'), { recursive: true })
  git.mockResolvedValue({ stdout: path.join(dir, 'elsewhere') })
  expect(await isCommittedSuiteRetirement(path.join(dir, 'features'), 'shop')).toBe(false)
  expect(git).toHaveBeenCalledTimes(1)
})
