import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_PORT,
  loadProjectConfig,
  normalizePersonalWikiPath,
  projectConfigPath,
  resolveProjectPort,
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
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })

    fs.writeFileSync(projectConfigPath(projectRoot), '{not json')
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('loads valid healAgent values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'manual' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'manual', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'wizard' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('loads valid editor values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vscode' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'vscode', personalWikiPath: null, autoProposePr: true, showDemo: true })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'cursor' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'cursor', personalWikiPath: null, autoProposePr: true, showDemo: true })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'system' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'system', personalWikiPath: null, autoProposePr: true, showDemo: true })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vim' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('persists only supported healAgent values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'codex', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
    expect(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).toBe(
      '{\n  "healAgent": "codex",\n  "editor": "auto",\n  "personalWikiPath": null,\n  "autoProposePr": true,\n  "showDemo": true\n}\n',
    )

    saveProjectConfig(projectRoot, { healAgent: 'other' as never, editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('persists only supported editor values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'cursor', personalWikiPath: null, autoProposePr: true, showDemo: true })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'cursor', personalWikiPath: null, autoProposePr: true, showDemo: true })

    saveProjectConfig(projectRoot, { healAgent: 'auto', editor: 'other' as never, personalWikiPath: null, autoProposePr: true, showDemo: true })
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('treats auto-PR as on unless the config explicitly turns it off', () => {
    // Opt-OUT, not opt-in: a workspace written before the setting existed —
    // and one that omits the key — still proposes. Only a literal `false`
    // stops a green healed run from opening a pull request.
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ autoProposePr: false }))
    expect(loadProjectConfig(projectRoot).autoProposePr).toBe(false)

    for (const loose of [undefined, 'no', 0, null]) {
      fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ autoProposePr: loose }))
      expect(loadProjectConfig(projectRoot).autoProposePr).toBe(true)
    }

    saveProjectConfig(projectRoot, { healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: false, showDemo: true })
    expect(loadProjectConfig(projectRoot).autoProposePr).toBe(false)
  })

  it('treats the demos as shown unless the config explicitly turns them off', () => {
    // Same opt-OUT rule: every workspace written before this field existed keeps
    // offering the demos, and only a literal `false` clears the status-bar pill.
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ showDemo: false }))
    expect(loadProjectConfig(projectRoot).showDemo).toBe(false)

    for (const loose of [undefined, 'no', 0, null]) {
      fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ showDemo: loose }))
      expect(loadProjectConfig(projectRoot).showDemo).toBe(true)
    }

    saveProjectConfig(projectRoot, { healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: false })
    expect(loadProjectConfig(projectRoot).showDemo).toBe(false)
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
    // Non-string inputs (project.json may load with the field set to a
    // number/object by accident) — exercise the `typeof !== 'string'` arm.
    expect(normalizePersonalWikiPath(123)).toBe(null)
    expect(normalizePersonalWikiPath({})).toBe(null)
  })

  it('expands ~ personal wiki paths', () => {
    expect(normalizePersonalWikiPath('~')).toBe(fs.realpathSync(os.homedir()))
  })

  it('expands ~/ personal wiki paths', () => {
    const documents = path.join(os.homedir(), 'Documents')
    expect(normalizePersonalWikiPath('~/Documents')).toBe(fs.realpathSync(documents))
  })

  it('expands ~\\ (Windows-style) personal wiki paths', () => {
    const documents = path.join(os.homedir(), 'Documents')
    expect(normalizePersonalWikiPath('~\\Documents')).toBe(fs.realpathSync(documents))
  })

  it('loads missing or invalid stored personal wiki paths as null', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ personalWikiPath: path.join(projectRoot, 'missing') }))
    expect(loadProjectConfig(projectRoot)).toEqual({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
  })

  it('loads a valid port and omits invalid or out-of-range ports', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ port: 8000 }))
    expect(loadProjectConfig(projectRoot).port).toBe(8000)

    for (const bad of [0, 70000, -1, 3000.5, '3000', null, {}]) {
      fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ port: bad }))
      expect(loadProjectConfig(projectRoot).port).toBeUndefined()
    }
  })

  it('does not add a port key to config files that omit it', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'codex', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })
    expect(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).toBe(
      '{\n  "healAgent": "codex",\n  "editor": "auto",\n  "personalWikiPath": null,\n  "autoProposePr": true,\n  "showDemo": true\n}\n',
    )
  })

  it('persists a valid port and drops invalid ones', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true, port: 8080 })
    expect(loadProjectConfig(projectRoot).port).toBe(8080)

    saveProjectConfig(projectRoot, { healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true, port: 99999 })
    expect(loadProjectConfig(projectRoot).port).toBeUndefined()
  })

  it('resolves the configured port or falls back to the default', () => {
    expect(resolveProjectPort({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true, port: 8000 })).toBe(8000)
    expect(resolveProjectPort({ healAgent: 'external', editor: 'auto', personalWikiPath: null, autoProposePr: true, showDemo: true })).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(7421)
  })
})
