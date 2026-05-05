import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadProjectConfig,
  projectConfigPath,
  saveProjectConfig,
} from './project-config'

const tmpDirs: string[] = []

function mkProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-project-config-')))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('project config', () => {
  it('returns defaults when the config file is missing or unreadable JSON', () => {
    const projectRoot = mkProject()
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })

    fs.writeFileSync(projectConfigPath(projectRoot), '{not json')
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })
  })

  it('loads valid healAgent values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'manual' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'manual', editor: 'auto' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'wizard' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })
  })

  it('loads valid editor values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vscode' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'vscode' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'cursor' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'cursor' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'system' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'system' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vim' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })
  })

  it('persists only supported healAgent values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'codex', editor: 'auto' })
    expect(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).toBe(
      '{\n  "healAgent": "codex",\n  "editor": "auto"\n}\n',
    )

    saveProjectConfig(projectRoot, { healAgent: 'other' as never, editor: 'auto' })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })
  })

  it('persists only supported editor values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'cursor' })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'cursor' })

    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'other' as never })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto' })
  })
})
