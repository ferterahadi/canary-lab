import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileSync = vi.fn(() => Buffer.from(''))
vi.mock('child_process', () => ({ execFileSync: (...args: unknown[]) => execFileSync(...(args as [])) }))

const { main } = await import('./install-browsers')

let messages: string[]

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-install-browsers-'))
}

beforeEach(() => {
  execFileSync.mockClear()
  execFileSync.mockImplementation(() => Buffer.from(''))
  messages = []
  vi.spyOn(console, 'log').mockImplementation((m) => { messages.push(String(m)) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('install-browsers', () => {
  it('installs chromium with the workspace-local playwright binary', async () => {
    const cwd = mkTmp()
    const bin = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '')

    await main([], { cwd, env: {} })

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      bin,
      ['install', 'chromium'],
      expect.objectContaining({ cwd }),
    )
  })

  it('falls back to playwright on PATH when the workspace has no local bin', async () => {
    const cwd = mkTmp()

    await main([], { cwd, env: {} })

    const expected = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      expected,
      ['install', 'chromium'],
      expect.objectContaining({ cwd }),
    )
  })

  it.each(['1', 'true', 'yes'])('skips the download when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=%s', async (raw) => {
    await main([], { cwd: mkTmp(), env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: raw } })

    expect(execFileSync).not.toHaveBeenCalled()
    expect(messages.join('\n')).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD')
  })

  it.each(['', '0', 'false', 'FALSE'])('treats PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=%s as not set', async (raw) => {
    await main([], { cwd: mkTmp(), env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: raw } })

    expect(execFileSync).toHaveBeenCalledOnce()
  })

  // It runs inside `npm install`. Throwing here would abort the install and
  // leave a workspace with no node_modules over a flaky CDN.
  it('reports a failed download without throwing', async () => {
    execFileSync.mockImplementation(() => { throw new Error('ECONNRESET') })

    await expect(main([], { cwd: mkTmp(), env: {} })).resolves.toBeUndefined()
    expect(messages.join('\n')).toContain('ECONNRESET')
    expect(messages.join('\n')).toContain('npm run install:browsers')
  })

  it('defaults cwd and env from the process', async () => {
    vi.stubEnv('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', '')

    await main()

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      ['install', 'chromium'],
      expect.objectContaining({ cwd: process.cwd() }),
    )
    vi.unstubAllEnvs()
  })
})
