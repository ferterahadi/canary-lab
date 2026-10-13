import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeEnvironment, serviceCommand, writeRunbook } from './runtime'
import { command, sourceRoot } from './files'
import { stopAttemptServices } from './cleanup'
import { trackTempDirs } from '../test-helpers/temp-dir'

vi.mock('./files', async (original) => ({ ...await original<typeof import('./files')>(), command: vi.fn() }))
const tempDir = trackTempDirs('study-runtime-')
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

it('removes inaccessible source and symlinked source PATH entries while retaining the pinned Node executable', () => {
  const root = tempDir(); fs.symlinkSync(sourceRoot, path.join(root, 'alias'))
  const env = runtimeEnvironment(root, { PATH: `${sourceRoot}/node_modules/.bin:${root}/alias:.:/usr/bin:/bin` })
  expect(env.PATH!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath))
  expect(env.PATH).not.toContain(sourceRoot); expect(env.PATH).not.toContain('alias')
  expect(env.PATH).toContain('/usr/bin'); expect(env.TMPDIR).toBe(path.join(root, '.tmp'))
})

it('documents the same loader command used by Canary and retains service environment and ports', () => {
  const root = tempDir()
  const commands = writeRunbook(root, { catalog: 19001, inventory: 19002, checkout: 19003 }, { STOREFRONT_CURRENCY: 'SGD' })
  expect(commands.start).toContain(serviceCommand('catalog'))
  expect(commands.start).not.toContain('npm'); expect(commands.start).toContain('PORT=19003')
  expect(fs.readFileSync(path.join(root, 'RUNBOOK.md'), 'utf8')).toContain(commands.test)
  expect(fs.readFileSync(path.join(root, 'environment.sh'), 'utf8')).toContain("STOREFRONT_CURRENCY='SGD'")
})

it('stops an escaped background service only when its cwd proves ownership and preserves unrelated port owners', async () => {
  const root = tempDir(); const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const output = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })
  vi.mocked(command).mockResolvedValueOnce(output('42101\n42102\n'))
    .mockResolvedValueOnce(output(`p42101\nfcwd\nn${root}/app\n`))
    .mockResolvedValueOnce(output('p42102\nfcwd\nn/unrelated/workspace\n'))
  await expect(stopAttemptServices(root, [19001, 19002])).rejects.toThrow('another process')
  expect(kill).toHaveBeenCalledExactlyOnceWith(42101, 'SIGKILL')
  expect(JSON.parse(fs.readFileSync(path.join(root, 'service-cleanup.json'), 'utf8'))).toHaveLength(2)
})
