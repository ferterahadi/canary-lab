import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readWorkspaceRegistry,
  registryPath,
  upsertWorkspace,
} from './workspace-registry'

const tmpDirs: string[] = []

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-registry-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('workspace registry', () => {
  it('returns an empty registry when the file is missing or malformed', () => {
    const home = mkTmp()
    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })

    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true })
    fs.writeFileSync(registryPath(home), '{not-json')

    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })
  })

  it('upserts workspaces by real path', () => {
    const home = mkTmp()
    const workspace = path.join(mkTmp(), 'my-folder')
    fs.mkdirSync(workspace)

    const first = upsertWorkspace(workspace, {
      homeDir: home,
      now: new Date('2026-05-24T00:00:00.000Z'),
    })
    const second = upsertWorkspace(workspace, {
      homeDir: home,
      now: new Date('2026-05-24T00:01:00.000Z'),
    })

    expect(first.name).toBe('my-folder')
    expect(second.createdAt).toBe('2026-05-24T00:00:00.000Z')
    expect(second.updatedAt).toBe('2026-05-24T00:01:00.000Z')
    expect(readWorkspaceRegistry(home).workspaces).toHaveLength(1)
  })
})
