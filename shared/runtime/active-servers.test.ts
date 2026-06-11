import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  activeServersPath,
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

  it('survives a corrupt file', () => {
    const homeDir = mkHome()
    fs.mkdirSync(path.dirname(activeServersPath(homeDir)), { recursive: true })
    fs.writeFileSync(activeServersPath(homeDir), '{ not json')
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toEqual([])
    // and a register recovers it
    registerActiveServer({ projectRoot: '/work/a', port: 7420, pid: 111 }, { homeDir, isAlive: alwaysAlive })
    expect(readActiveServers({ homeDir, isAlive: alwaysAlive })).toHaveLength(1)
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

  it('prefers the server matching CANARY_LAB_PROJECT_ROOT', () => {
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-02-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, env: { CANARY_LAB_PROJECT_ROOT: '/work/b' } as NodeJS.ProcessEnv })
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

  it('falls back to the most recently registered server', () => {
    const servers = [
      base({ projectRoot: '/work/a', port: 7420, updatedAt: '2026-01-01T00:00:00.000Z' }),
      base({ projectRoot: '/work/b', port: 7500, updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const match = resolveActiveServer({ servers, cwd: '/somewhere/else', env: {} as NodeJS.ProcessEnv })
    expect(match?.port).toBe(7500)
  })
})
