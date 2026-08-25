import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  activeServersPath,
  liveRegistryHome,
  readActiveServers,
  registerActiveServer,
  resolveActiveServer,
  unregisterActiveServer,
} from './active-servers'

const tmpDirs: string[] = []
function mkHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-active-')))
  tmpDirs.push(dir)
  return dir
}
const alwaysAlive = () => true
const alwaysDead = () => false

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('active-servers', () => {
  it('registers and reads back a live server', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toEqual([
      expect.objectContaining({ projectRoot: '/work/a', port: 7420, pid: 111 }),
    ])
  })

  it('returns no entries when the file is absent', () => {
    expect(readActiveServers({ homeDir: mkHome(), isAlive: alwaysAlive })).toEqual([])
  })

  it('keeps one entry per project root, following the latest port', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    registerActiveServer({ projectRoot: '/work/a', port: 7500, pid: 222 }, { homeDir, isAlive: alwaysAlive })
    const servers = readActiveServers({ homeDir, isAlive: alwaysAlive })
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ port: 7500, pid: 222 })
  })

  it('prunes dead pids on read and on the next register', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(readActiveServers({ homeDir, isAlive: alwaysDead })).toEqual([])

    // A new live server registers; the dead one is dropped from the file.
    registerActiveServer(
      { projectRoot: '/work/b', port: 7421, pid: 222 },
      { homeDir, isAlive: (pid) => pid === 222 },
    )
    const raw = JSON.parse(fs.readFileSync(activeServersPath(homeDir), 'utf-8')) as { servers: unknown[] }
    expect(raw.servers).toHaveLength(1)
  })

  it('unregisters by pid', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    unregisterActiveServer({ pid: 111 }, { homeDir })
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toEqual([])
  })

  it('unregisters by project root, resolving the path first', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    registerActiveServer({ projectRoot: '/work/b', port: 7500, pid: 222 }, { homeDir, isAlive: alwaysAlive })
    // A non-normalized root must still match — callers pass whatever cwd gave
    // them, and a stale record would strand the bridge on a dead port.
    unregisterActiveServer({ projectRoot: '/work/./a/' }, { homeDir })
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive }).map((s) => s.port)).toEqual([7500])
  })

  it('unregistering is a no-op when no record file exists', () => {
    const homeDir = mkHome()
    expect(() => unregisterActiveServer({ pid: 1 }, { homeDir })).not.toThrow()
    expect(fs.existsSync(activeServersPath(homeDir))).toBe(false)
  })

  it('drops rows from a different schema version or malformed shape', () => {
    const homeDir = mkHome()
    fs.mkdirSync(path.dirname(activeServersPath(homeDir)), { recursive: true })
    fs.writeFileSync(activeServersPath(homeDir), JSON.stringify({ version: 2, servers: [] }))
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toEqual([])

    // A half-written row must not surface: the bridge would dial `undefined`
    // as a port and fail with a confusing connection error.
    fs.writeFileSync(activeServersPath(homeDir), JSON.stringify({
      version: 1,
      servers: [
        null,
        'not-an-entry',
        { projectRoot: '/work/a', port: 7.5, pid: 1, updatedAt: 'x' },
        { projectRoot: '/work/b', port: 7500, pid: 222, updatedAt: 'x' },
      ],
    }))
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive }).map((s) => s.port)).toEqual([7500])
  })

  it('survives a corrupt file', () => {
    const homeDir = mkHome()
    fs.mkdirSync(path.dirname(activeServersPath(homeDir)), { recursive: true })
    fs.writeFileSync(activeServersPath(homeDir), '{ not json')
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toEqual([])
    // and a register recovers it
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toHaveLength(1)
  })

  it('probes real pids when no isAlive is injected', () => {
    // The default liveness probe is what runs in production; with no injected
    // one, this process must read as alive and an unused pid as gone.
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/live', port: 7420, pid: process.pid }, { homeDir })
    fs.writeFileSync(activeServersPath(homeDir), JSON.stringify({
      version: 1,
      servers: [
        { projectRoot: '/work/live', port: 7420, pid: process.pid, updatedAt: 'x' },
        // Above every platform's pid ceiling (macOS caps at 99998, Linux at
        // 4194304), so the probe always sees ESRCH rather than a recycled pid.
        { projectRoot: '/work/dead', port: 7500, pid: 2_147_483_646, updatedAt: 'x' },
      ],
    }))
    expect(readActiveServers({ homeDir }).map((s) => s.projectRoot)).toEqual(['/work/live'])
  })

  it('matches project roots case-insensitively on Windows', () => {
    const homeDir = mkHome()
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      registerActiveServer({ projectRoot: '/Work/A', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
      // Same root in different casing: the new registration must replace the
      // old one rather than leave two records fighting over one port.
      registerActiveServer({ projectRoot: '/work/a', port: 7430, pid: 222 }, { homeDir, isAlive: alwaysAlive })
      expect(readActiveServers({ homeDir, isAlive: alwaysAlive }).map((s) => s.port)).toEqual([7430])
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })
})

describe('resolveActiveServer', () => {
  const base = (over: Partial<{ projectRoot: string; port: number; pid: number; updatedAt: string }>) => ({
    projectRoot: '/work/a',
    port: 7420,
    pid: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })

  it('returns null when nothing is running', () => {
    expect(resolveActiveServer({ servers: [] })).toBeNull()
  })

  it('reads the records from disk and the real env when neither is injected', () => {
    // The production call site passes neither, so this is the path the MCP
    // bridge actually takes when it follows the running server.
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(resolveActiveServer({ homeDir, isAlive: alwaysAlive })?.port).toBe(7420)
  })

  it('returns null when every recorded server is dead', () => {
    const homeDir = mkHome()
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(resolveActiveServer({ homeDir, isAlive: alwaysDead })).toBeNull()
  })

  it('prefers the server matching CANARY_LAB_PROJECT_ROOT', () => {
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-02-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, env: { CANARY_LAB_PROJECT_ROOT: '/work/b' } as NodeJS.ProcessEnv })
    expect(match?.port).toBe(7500)
  })

  it('falls through when CANARY_LAB_PROJECT_ROOT names no running server', () => {
    // The env var is a preference, not a filter: pointing it at a workspace
    // that has no server must not strand the bridge with nothing to dial.
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({
      servers,
      env: { CANARY_LAB_PROJECT_ROOT: '/work/nothing-here' } as NodeJS.ProcessEnv,
    })
    expect(match?.port).toBe(7500)
  })

  it('prefers the server enclosing the cwd over the most recent', () => {
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-02-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, cwd: '/work/b/features/x', env: {} as NodeJS.ProcessEnv })
    expect(match?.port).toBe(7500)
  })

  it('picks the nearest enclosing root when several enclose the cwd', () => {
    // Nested workspaces both enclose the cwd; the deeper one owns it, so the
    // comparator has to order by root length rather than take the first hit.
    const servers = [
      base({ projectRoot: '/work', port: 7400, updatedAt: '2026-03-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, cwd: '/work/a/features/x', env: {} as NodeJS.ProcessEnv })
    expect(match?.port).toBe(7420)
  })

  it('treats a root recorded with a trailing separator as enclosing', () => {
    const withSlash = base({ projectRoot: '/work/a/', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' })
    const newer = base({ projectRoot: '/elsewhere', port: 7500, updatedAt: '2026-03-01T00:00:00.000Z' })
    const servers = [withSlash, newer]

    // The trailing separator must not defeat the prefix check: the older
    // enclosing server still beats the more recent unrelated one.
    expect(resolveActiveServer({ servers, cwd: '/work/a/features', env: {} as NodeJS.ProcessEnv })?.port).toBe(7420)

    // A sibling shares a string prefix but not a path prefix, so nothing
    // encloses the cwd and the most-recent server wins instead.
    expect(resolveActiveServer({ servers, cwd: '/work/ab', env: {} as NodeJS.ProcessEnv })?.port).toBe(7500)
  })

  it('falls back to the most recently registered server', () => {
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, cwd: '/somewhere/else', env: {} as NodeJS.ProcessEnv })
    expect(match?.port).toBe(7500)
  })

  // The failure this prevents: a demo or smoke-test workspace under the OS temp
  // dir registers LAST, so recency alone hands every unpinned session a folder
  // the OS may delete — which is how a flight ends up running in a throwaway
  // workspace instead of the user's.
  it('prefers a durable workspace over a newer temp one', () => {
    const servers = [
      base({ projectRoot: '/work/durable', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' }),
      base({
        projectRoot: path.join(os.tmpdir(), 'canary-lab-demo-x', 'demo-project'),
        port: 50258,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]
    expect(resolveActiveServer({ servers, cwd: '/somewhere/else', env: {} as NodeJS.ProcessEnv })?.port).toBe(7420)
  })

  // But reachable beats unreachable: when the demo is the only thing running, an
  // agent asking for it must still be able to find it.
  it('uses a temp workspace when it is the only live server', () => {
    const servers = [base({ projectRoot: path.join(os.tmpdir(), 'canary-lab-demo-x', 'demo-project'), port: 50258 })]
    expect(resolveActiveServer({ servers, cwd: '/somewhere/else', env: {} as NodeJS.ProcessEnv })?.port).toBe(50258)
  })

  // An explicit pin still wins outright — a GUI client registered FOR the demo
  // must reach it even while a durable workspace is also up.
  it('honours an explicit pin at a temp workspace', () => {
    const demoRoot = path.join(os.tmpdir(), 'canary-lab-demo-x', 'demo-project')
    const servers = [
      base({ projectRoot: '/work/durable', port: 7420, updatedAt: '2026-03-01T00:00:00.000Z' }),
      base({ projectRoot: demoRoot, port: 50258 }),
    ]
    const match = resolveActiveServer({
      servers,
      env: { CANARY_LAB_PROJECT_ROOT: demoRoot } as NodeJS.ProcessEnv,
    })
    expect(match?.port).toBe(50258)
  })
})

describe('liveRegistryHome', () => {
  // Liveness is machine-wide on purpose: CANARY_LAB_HOME isolates the user's own
  // state, and honouring it here is what hid the demo's server from every client
  // that wasn't launched inside the demo folder.
  it('ignores CANARY_LAB_HOME and uses the real home', () => {
    expect(liveRegistryHome({ CANARY_LAB_HOME: '/tmp/isolated' } as NodeJS.ProcessEnv)).toBe(os.homedir())
  })

  it('honours an explicit live-registry override', () => {
    expect(liveRegistryHome({ CANARY_LAB_LIVE_REGISTRY_HOME: '/tmp/sandbox' } as NodeJS.ProcessEnv)).toBe('/tmp/sandbox')
  })

  it('treats a blank override as unset', () => {
    expect(liveRegistryHome({ CANARY_LAB_LIVE_REGISTRY_HOME: '  ' } as NodeJS.ProcessEnv)).toBe(os.homedir())
  })

  it('defaults the record path to the real home', () => {
    expect(activeServersPath()).toBe(path.join(os.homedir(), '.canary-lab', 'active-servers.json'))
  })
})
