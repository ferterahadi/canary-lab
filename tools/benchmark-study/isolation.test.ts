import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareNativeIsolation } from './isolation'
import { checked, command, json, sourceRoot } from './files'
import { trackTempDirs } from '../test-helpers/temp-dir'

vi.mock('./files', async (original) => ({ ...await original<typeof import('./files')>(), checked: vi.fn(), command: vi.fn() }))
const tempDir = trackTempDirs('study-policy-')
afterEach(() => { vi.resetAllMocks() })
function fixture(): { root: string; attempt: string } {
  const root = tempDir()
  const attempt = path.join(root, 'attempts/current')
  fs.mkdirSync(attempt, { recursive: true }); fs.mkdirSync(path.join(root, 'attempts/other'))
  fs.mkdirSync(path.join(root, 'runtime/node_modules/canary-lab'), { recursive: true })
  json(path.join(root, 'study.json'), {})
  return { root, attempt }
}

it('retains native sandbox enforcement and protects control files in both CLI policies', async () => {
  const { root, attempt } = fixture()
  if (process.platform !== 'darwin') { await expect(prepareNativeIsolation(root, attempt, 'plain', 'claude')).rejects.toThrow('requires macOS'); return }
  const native = await prepareNativeIsolation(root, attempt, 'plain', 'claude')
  const settings = JSON.parse(fs.readFileSync(native.claudeSettings, 'utf8'))
  expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false })
  expect(settings.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: false, additionalDirectories: [attempt] })
  expect(settings.sandbox.filesystem.denyRead).not.toContain(root)
  expect(settings.sandbox.filesystem.denyRead).toContain(path.join(root, 'study.json'))
  expect(settings.sandbox.filesystem.denyRead).toContain(sourceRoot)
  expect(settings.sandbox.filesystem.denyRead).toContain(path.join(root, 'runtime/node_modules/canary-lab'))
  expect(settings.permissions.deny).toContain(`Read(/${root}/study.json)`)
  expect(settings.permissions.deny).toContain(`Read(/${root}/attempts/other/**)`)
  expect(settings.sandbox.filesystem.denyWrite).toContain(native.claudeSettings)
  expect(native.codexArgs.join(' ')).toContain('extends=":workspace"')
  expect(native.codexArgs).not.toContain('--sandbox')
})

it('requires a successful own-file probe and actual native permission denial', async () => {
  if (process.platform !== 'darwin') return
  const { root, attempt } = fixture()
  vi.mocked(checked).mockResolvedValue('own file')
  vi.mocked(command).mockResolvedValue({ code: 1, stderr: 'Operation not permitted', stdout: '', timedOut: false })
  await prepareNativeIsolation(root, attempt, 'plain', 'codex')
  expect(command).toHaveBeenCalledTimes(2)
  vi.mocked(command).mockResolvedValue({ code: 0, stderr: '', stdout: 'private data', timedOut: false })
  await expect(prepareNativeIsolation(root, attempt, 'canary', 'codex')).rejects.toThrow('did not deny')
  vi.mocked(command).mockResolvedValue({ code: 1, stderr: 'invalid configuration', stdout: '', timedOut: false })
  await expect(prepareNativeIsolation(root, attempt, 'canary', 'codex')).rejects.toThrow('did not deny')
})
