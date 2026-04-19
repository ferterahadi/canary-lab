import { describe, it, expect, vi, beforeEach } from 'vitest'

const runRunner = vi.fn(async () => {})
const runEnv = vi.fn(async () => {})
const createFeature = vi.fn(async () => {})
const initProject = vi.fn(async () => {})
const upgradeProject = vi.fn(async () => {})

vi.mock('../shared/e2e-runner/runner', () => ({ main: runRunner }))
vi.mock('../shared/env-switcher/root-cli', () => ({ main: runEnv }))
vi.mock('./new-feature', () => ({ main: createFeature }))
vi.mock('./init-project', () => ({ main: initProject }))
vi.mock('./upgrade', () => ({ main: upgradeProject }))

const { main, printUsage } = await import('./cli')

beforeEach(() => {
  runRunner.mockClear()
  runEnv.mockClear()
  createFeature.mockClear()
  initProject.mockClear()
  upgradeProject.mockClear()
})

describe('printUsage', () => {
  it('prints all documented subcommands', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printUsage()
    const out = spy.mock.calls.map((c) => c[0]).join('\n')
    spy.mockRestore()
    expect(out).toContain('canary-lab init <folder>')
    expect(out).toContain('canary-lab run')
    expect(out).toContain('canary-lab env')
    expect(out).toContain('canary-lab new-feature <name>')
    expect(out).toContain('canary-lab upgrade')
  })
})

describe('main (cli routing)', () => {
  it('routes "init" and forwards remaining args', async () => {
    await main(['init', 'myproj', '--package-spec', '^1.0.0'])
    expect(initProject).toHaveBeenCalledExactlyOnceWith(['myproj', '--package-spec', '^1.0.0'])
  })

  it('routes "run" and forwards remaining args', async () => {
    await main(['run', '--headed', '--terminal', 'Terminal'])
    expect(runRunner).toHaveBeenCalledExactlyOnceWith(['--headed', '--terminal', 'Terminal'])
  })

  it('routes "env"', async () => {
    await main(['env', '--apply'])
    expect(runEnv).toHaveBeenCalledExactlyOnceWith(['--apply'])
  })

  it('routes "new-feature"', async () => {
    await main(['new-feature', 'cns_webhooks', 'desc'])
    expect(createFeature).toHaveBeenCalledExactlyOnceWith(['cns_webhooks', 'desc'])
  })

  it('routes "upgrade"', async () => {
    await main(['upgrade', '--silent'])
    expect(upgradeProject).toHaveBeenCalledExactlyOnceWith(['--silent'])
  })

  it('prints usage for -h / --help / no command', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['-h'])
    await main(['--help'])
    await main([])
    spy.mockRestore()
    expect(initProject).not.toHaveBeenCalled()
    expect(runRunner).not.toHaveBeenCalled()
  })

  it('unknown command prints error + usage + exits 1', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit__${code}`)
      }) as never)
    await expect(main(['bogus'])).rejects.toThrow('__exit__1')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command: bogus'))
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
