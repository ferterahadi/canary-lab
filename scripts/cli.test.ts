import { describe, it, expect, vi, beforeEach } from 'vitest'

const initProject = vi.fn(async () => {})
const upgradeProject = vi.fn(async () => {})
const runUi = vi.fn(async () => {})
const createFeature = vi.fn(async () => {})
const runEnv = vi.fn(async () => {})

vi.mock('./init-project', () => ({ main: initProject }))
vi.mock('./upgrade', () => ({ main: upgradeProject }))
vi.mock('./ui-command', () => ({ runUi }))
vi.mock('./new-feature', () => ({ main: createFeature }))
vi.mock('./env', () => ({ main: runEnv }))

const { main, printUsage } = await import('./cli')

beforeEach(() => {
  initProject.mockClear()
  upgradeProject.mockClear()
  runUi.mockClear()
  createFeature.mockClear()
  runEnv.mockClear()
})

describe('printUsage', () => {
  it('prints all documented subcommands', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printUsage()
    const out = spy.mock.calls.map((c) => c[0]).join('\n')
    spy.mockRestore()
    expect(out).toContain('canary-lab init <folder>')
    expect(out).toContain('canary-lab ui')
    expect(out).toContain('canary-lab new feature <name>')
    expect(out).toContain('canary-lab new-feature <name>')
    expect(out).toContain('canary-lab env apply <feature> <set>')
    expect(out).toContain('canary-lab env revert <feature>')
    expect(out).toContain('canary-lab upgrade')
    expect(out).not.toContain('canary-lab run')
  })
})

describe('main (cli routing)', () => {
  it('routes "init" and forwards remaining args', async () => {
    await main(['init', 'myproj', '--package-spec', '^1.0.0'])
    expect(initProject).toHaveBeenCalledExactlyOnceWith(['myproj', '--package-spec', '^1.0.0'])
  })

  it('routes "ui" and forwards remaining args', async () => {
    await main(['ui', '--port', '8080'])
    expect(runUi).toHaveBeenCalledExactlyOnceWith(['--port', '8080'])
  })

  it('routes "new feature" and forwards remaining args', async () => {
    await main(['new', 'feature', 'demo_login', '--description', 'Demo login'])
    expect(createFeature).toHaveBeenCalledExactlyOnceWith(['demo_login', '--description', 'Demo login'])
  })

  it('routes "new-feature" compatibility alias', async () => {
    await main(['new-feature', 'demo_login'])
    expect(createFeature).toHaveBeenCalledExactlyOnceWith(['demo_login'])
  })

  it('routes deterministic env commands', async () => {
    await main(['env', 'apply', 'demo', 'local'])
    await main(['env', 'revert', 'demo'])
    expect(runEnv).toHaveBeenNthCalledWith(1, ['apply', 'demo', 'local'])
    expect(runEnv).toHaveBeenNthCalledWith(2, ['revert', 'demo'])
  })

  it('routes "upgrade"', async () => {
    await main(['upgrade', '--silent'])
    expect(upgradeProject).toHaveBeenCalledExactlyOnceWith(
      ['--silent'],
      expect.objectContaining({ confirm: expect.any(Function) }),
    )
  })

  it.each([['run']] as const)('"%s" prints a migration hint and exits 1', async (cmd) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit__${code}`)
      }) as never)
    await expect(main([cmd])).rejects.toThrow('__exit__1')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('canary-lab ui'))
    errSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('prints usage for -h / --help / no command', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['-h'])
    await main(['--help'])
    await main([])
    spy.mockRestore()
    expect(initProject).not.toHaveBeenCalled()
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
