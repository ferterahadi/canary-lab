import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_PORT,
  loadProjectConfig,
  normalizeEditor,
  normalizeHealAgent,
  normalizePersonalWikiPath,
  projectConfigPath,
  resolveProjectPort,
  saveProjectConfig,
  type ProjectConfig,
} from './project-config'

const tmpDirs: string[] = []

function mkProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-project-config-')))
  tmpDirs.push(dir)
  return dir
}

// The shipped defaults, spread into per-test variants so a new config field
// changes exactly one place.
const DEFAULTS: ProjectConfig = {
  healAgent: 'claude',
  editor: 'auto',
  agentModels: { claude: {}, codex: {} },
  askModelsOnLaunch: false,
  personalWikiPath: null,
  autoProposePr: true,
  showDemo: true,
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('project config', () => {
  it('returns defaults when the config file is missing or unreadable JSON', () => {
    const projectRoot = mkProject()
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)

    fs.writeFileSync(projectConfigPath(projectRoot), '{not json')
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)
  })

  it('loads valid healAgent values and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'manual' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ ...DEFAULTS, healAgent: 'manual' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'wizard' }))
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)
  })

  it('migrates a stored `external` healAgent to claude silently (2.2.0)', () => {
    // The retired value must not error, warn, or survive: a workspace saved on
    // 2.1.x loads as claude, and the next save persists the migrated value.
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ healAgent: 'external' }))
    const loaded = loadProjectConfig(projectRoot)
    expect(loaded.healAgent).toBe('claude')

    saveProjectConfig(projectRoot, loaded)
    expect(JSON.parse(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).healAgent).toBe('claude')
  })

  it('normalizeHealAgent maps external to claude, passes live values, rejects junk', () => {
    expect(normalizeHealAgent('external')).toBe('claude')
    expect(normalizeHealAgent('claude')).toBe('claude')
    expect(normalizeHealAgent('codex')).toBe('codex')
    expect(normalizeHealAgent('auto')).toBe('auto')
    expect(normalizeHealAgent('manual')).toBe('manual')
    expect(normalizeHealAgent('wizard')).toBeUndefined()
    expect(normalizeHealAgent(undefined)).toBeUndefined()
  })

  it('loads live editor values, migrates system to auto, and falls back for unknown values', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vscode' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ ...DEFAULTS, editor: 'vscode' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'cursor' }))
    expect(loadProjectConfig(projectRoot)).toEqual({ ...DEFAULTS, editor: 'cursor' })

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'system' }))
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)

    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ editor: 'vim' }))
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)
  })

  it('normalizes the retired system preference into auto-detect', () => {
    expect(normalizeEditor('system')).toBe('auto')
    expect(normalizeEditor('auto')).toBe('auto')
    expect(normalizeEditor('cursor')).toBe('cursor')
    expect(normalizeEditor('vscode')).toBe('vscode')
    expect(normalizeEditor('vim')).toBeUndefined()
  })

  it('persists only supported healAgent values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { ...DEFAULTS, healAgent: 'codex' })
    expect(JSON.parse(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).healAgent).toBe('codex')

    saveProjectConfig(projectRoot, { ...DEFAULTS, healAgent: 'other' as never })
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)
  })

  it('persists only supported editor values', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { ...DEFAULTS, healAgent: 'auto', editor: 'cursor' })
    expect(loadProjectConfig(projectRoot)).toEqual({ ...DEFAULTS, healAgent: 'auto', editor: 'cursor' })

    saveProjectConfig(projectRoot, { ...DEFAULTS, healAgent: 'auto', editor: 'other' as never })
    expect(loadProjectConfig(projectRoot)).toEqual({ ...DEFAULTS, healAgent: 'auto' })

    saveProjectConfig(projectRoot, { ...DEFAULTS, editor: 'system' })
    expect(JSON.parse(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8')).editor).toBe('auto')
  })

  it('round-trips agentModels and drops junk stages/efforts on the way through', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, {
      ...DEFAULTS,
      agentModels: {
        claude: { heal: { model: 'opus', effort: 'high' }, prd: { model: 'sonnet', effort: null } },
        codex: { heal: { model: null, effort: 'xhigh' } },
      },
    })
    expect(loadProjectConfig(projectRoot).agentModels).toEqual({
      claude: { heal: { model: 'opus', effort: 'high' }, prd: { model: 'sonnet', effort: null } },
      codex: { heal: { model: null, effort: 'xhigh' } },
    })

    // Hand-edited junk in the file: unknown stage, effort from the wrong CLI's
    // vocabulary, an all-default entry — all normalize away rather than erroring.
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({
      agentModels: {
        claude: { warp: { model: 'opus' }, heal: { model: 'opus', effort: 'minimal' }, docs: { model: null, effort: null } },
        codex: 'nope',
      },
    }))
    expect(loadProjectConfig(projectRoot).agentModels).toEqual({
      claude: { heal: { model: 'opus', effort: null } },
      codex: {},
    })
  })

  it('askModelsOnLaunch is opt-in: only a literal true arms the launch gate', () => {
    const projectRoot = mkProject()
    fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ askModelsOnLaunch: true }))
    expect(loadProjectConfig(projectRoot).askModelsOnLaunch).toBe(true)

    for (const loose of [undefined, 'yes', 1, null, false]) {
      fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify({ askModelsOnLaunch: loose }))
      expect(loadProjectConfig(projectRoot).askModelsOnLaunch).toBe(false)
    }

    saveProjectConfig(projectRoot, { ...DEFAULTS, askModelsOnLaunch: true })
    expect(loadProjectConfig(projectRoot).askModelsOnLaunch).toBe(true)
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

    saveProjectConfig(projectRoot, { ...DEFAULTS, autoProposePr: false })
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

    saveProjectConfig(projectRoot, { ...DEFAULTS, showDemo: false })
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
    expect(loadProjectConfig(projectRoot)).toEqual(DEFAULTS)
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
    saveProjectConfig(projectRoot, { ...DEFAULTS, healAgent: 'codex' })
    const written = JSON.parse(fs.readFileSync(projectConfigPath(projectRoot), 'utf-8'))
    expect('port' in written).toBe(false)
    expect(written.healAgent).toBe('codex')
  })

  it('persists a valid port and drops invalid ones', () => {
    const projectRoot = mkProject()
    saveProjectConfig(projectRoot, { ...DEFAULTS, port: 8080 })
    expect(loadProjectConfig(projectRoot).port).toBe(8080)

    saveProjectConfig(projectRoot, { ...DEFAULTS, port: 99999 })
    expect(loadProjectConfig(projectRoot).port).toBeUndefined()
  })

  it('resolves the configured port or falls back to the default', () => {
    expect(resolveProjectPort({ ...DEFAULTS, port: 8000 })).toBe(8000)
    expect(resolveProjectPort(DEFAULTS)).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(7421)
  })
})
