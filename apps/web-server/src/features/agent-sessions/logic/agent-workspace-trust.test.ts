import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  claudeGlobalConfigFile,
  claudeTrustedPath,
  ensureClaudeWorkspaceTrusted,
} from './agent-workspace-trust'

// The trust file is the user's real claude config, so every test here points
// the module at a temp copy via `configFile` and never touches `~`.

let dir: string
let configFile: string
let workspace: string

const write = (config: unknown) => fs.writeFileSync(configFile, JSON.stringify(config))
const read = () => JSON.parse(fs.readFileSync(configFile, 'utf-8'))

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-trust-')))
  configFile = path.join(dir, '.claude.json')
  workspace = path.join(dir, 'workspace')
  fs.mkdirSync(path.join(workspace, 'logs', 'runs', 'r1'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('claudeGlobalConfigFile', () => {
  it('is ~/.claude.json — a sibling of ~/.claude, not a file inside it', () => {
    expect(claudeGlobalConfigFile('/home/dev')).toBe('/home/dev/.claude.json')
  })

  it('keeps the same basename inside CLAUDE_CONFIG_DIR when relocated', () => {
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude-home'
    expect(claudeGlobalConfigFile('/home/dev')).toBe('/opt/claude-home/.claude.json')
  })

  it('ignores a whitespace-only CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '   '
    expect(claudeGlobalConfigFile('/home/dev')).toBe('/home/dev/.claude.json')
  })

  it('defaults the home dir to the current user when not given', () => {
    expect(claudeGlobalConfigFile()).toBe(path.join(os.homedir(), '.claude.json'))
  })
})

describe('claudeTrustedPath', () => {
  const runDir = () => path.join(workspace, 'logs', 'runs', 'r1')

  it('returns null when the config file does not exist', () => {
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBeNull()
  })

  it('returns null when the config parses to a non-object', () => {
    fs.writeFileSync(configFile, '42')
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBeNull()
  })

  it('returns null when the config has no projects map', () => {
    write({ numStartups: 3 })
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBeNull()
  })

  it('does not treat a trusted ancestor as trust for a fresh run directory', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBeNull()
  })

  it('finds trust on the directory itself', () => {
    write({ projects: { [runDir()]: { hasTrustDialogAccepted: true } } })
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBe(runDir())
  })

  it('does not count an entry that exists but was declined', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: false } } })
    expect(claudeTrustedPath(runDir(), { configFile, homeDir: dir })).toBeNull()
  })

  it('resolves symlinks — claude keys its config on the real path', () => {
    const link = path.join(dir, 'link-to-workspace')
    fs.symlinkSync(workspace, link)
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    expect(claudeTrustedPath(link, { configFile, homeDir: dir })).toBe(workspace)
  })

  it('falls back to the resolved path when the directory does not exist yet', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    const missing = path.join(workspace, 'logs', 'runs', 'never-created')
    expect(claudeTrustedPath(missing, { configFile, homeDir: dir })).toBeNull()
  })

  it('reads the default config location when none is passed', () => {
    process.env.CLAUDE_CONFIG_DIR = dir
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    expect(claudeTrustedPath(workspace, { homeDir: dir })).toBe(workspace)
  })

  it('falls back to the real home dir when neither option is passed', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    // An explicit configFile makes the lookup deterministic; homeDir is left to
    // default so the `os.homedir()` arm is the one under test.
    expect(claudeTrustedPath(workspace, { configFile })).toBe(workspace)
  })
})

describe('ensureClaudeWorkspaceTrusted', () => {
  it('no-ops when the exact directory is already trusted', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    const before = fs.readFileSync(configFile, 'utf-8')
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir })).toEqual({
      outcome: 'already-trusted',
      trustedPath: workspace,
    })
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(before)
  })

  it('adds the entry and leaves every other key untouched', () => {
    write({ numStartups: 7, projects: { '/elsewhere': { hasTrustDialogAccepted: true, lastCost: 4 } } })
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir })).toEqual({
      outcome: 'granted',
      trustedPath: workspace,
    })
    expect(read()).toEqual({
      numStartups: 7,
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: true, lastCost: 4 },
        [workspace]: { hasTrustDialogAccepted: true },
      },
    })
  })

  it('merges into an existing declined entry rather than replacing it', () => {
    write({ projects: { [workspace]: { hasTrustDialogAccepted: false, lastSessionId: 'abc' } } })
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir }).outcome).toBe('granted')
    expect(read().projects[workspace]).toEqual({ hasTrustDialogAccepted: true, lastSessionId: 'abc' })
  })

  it('creates the projects map when the config has none', () => {
    write({ numStartups: 1 })
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir }).outcome).toBe('granted')
    expect(read().projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('leaves no temp file behind', () => {
    write({ projects: {} })
    ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir })
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('refuses the filesystem root — too broad to claim on the user behalf', () => {
    write({ projects: {} })
    const result = ensureClaudeWorkspaceTrusted(path.parse(dir).root, { configFile, homeDir: dir })
    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toMatch(/too broad/)
  })

  it('refuses the home directory', () => {
    write({ projects: {} })
    const result = ensureClaudeWorkspaceTrusted(dir, { configFile, homeDir: dir })
    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toMatch(/too broad/)
  })

  it('reports unavailable — never invents a config — when the CLI has never run', () => {
    const result = ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir })
    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toMatch(/missing or unreadable/)
    expect(fs.existsSync(configFile)).toBe(false)
  })

  it('reports unavailable when the config is corrupt', () => {
    fs.writeFileSync(configFile, '{not json')
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir }).outcome).toBe('unavailable')
  })

  it('reports unavailable — and does not damage the config — when the write fails', () => {
    write({ projects: {} })
    // Occupy the exact temp path with a directory so writeFileSync gets EISDIR.
    fs.mkdirSync(`${configFile}.canary-lab-${process.pid}.tmp`)
    const result = ensureClaudeWorkspaceTrusted(workspace, { configFile, homeDir: dir })
    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toMatch(/could not update/)
    expect(read()).toEqual({ projects: {} })
  })

  it('resolves the default config location when none is passed', () => {
    process.env.CLAUDE_CONFIG_DIR = dir
    write({ projects: {} })
    expect(ensureClaudeWorkspaceTrusted(workspace, { homeDir: dir }).outcome).toBe('granted')
    expect(read().projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('uses the real home dir when none is passed', () => {
    write({ projects: {} })
    expect(ensureClaudeWorkspaceTrusted(workspace, { configFile }).outcome).toBe('granted')
  })
})
