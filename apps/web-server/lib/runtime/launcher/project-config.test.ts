import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadProjectConfig,
  normalizePersonalWikiPath,
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
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })

    fs.writeFileSync(projectConfigPath(projectRoot), '{not json')
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })

  it('loads valid healAgent values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'manual' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'manual', editor: 'auto', personalWikiPath: null })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'wizard' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })

  it('loads valid editor values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vscode' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'vscode', personalWikiPath: null })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'cursor' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'cursor', personalWikiPath: null })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'system' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'system', personalWikiPath: null })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vim' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })

  it('persists only supported healAgent values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'codex', editor: 'auto', personalWikiPath: null })
    expect(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).toBe(
      '{\n  "healAgent": "codex",\n  "editor": "auto",\n  "personalWikiPath": null\n}\n',
    )

    saveProjectConfig(projectRoot, { healAgent: 'other' as never, editor: 'auto', personalWikiPath: null })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })

  it('persists only supported editor values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'cursor', personalWikiPath: null })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'cursor', personalWikiPath: null })

    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'other' as never, personalWikiPath: null })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })

  it('normalizes valid personal wiki paths and clears invalid ones', () => {
    const projectRoot = mkProject()
    const wiki = path.join(projectRoot, 'wiki')
    const notDir = path.join(projectRoot, 'note.md')
    fs.mkdirSync(wiki)
    fs.writeFileSync(notDir, 'x')

    expect(normalizePersonalWikiPath(wiki)).toBe(fs.realpathSync(wiki))
    expect(normalizePersonalWikiPath('')).toBe(null)
    expect(normalizePersonalWikiPath('relative/wiki')).toBe(null)
    expect(normalizePersonalWikiPath(path.join(projectRoot, 'missing'))).toBe(null)
    expect(normalizePersonalWikiPath(notDir)).toBe(null)
  })

  it('expands ~ personal wiki paths', () => {
    expect(normalizePersonalWikiPath('~')).toBe(fs.realpathSync(os.homedir()))
  })

  it('loads missing or invalid stored personal wiki paths as null', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ personalWikiPath: path.join(projectRoot, 'missing') }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
  })
})
