import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ensureHealWorkspaceTrusted, healWorkspaceTrustRoot } from './run-heal-agent'
import type { RunContext } from './run-context'

// The heal REPL is the only agent canary spawns on an interactive TTY, so it is
// the only one Claude Code's folder-trust prompt can stop. These pin the seam
// that settles it before the spawn, and — just as important — that the user is
// TOLD, because it edits their CLI config.

let dir: string
let workspace: string

/** Only the fields the trust seam reads, plus a chunk sink for the transcript. */
function mkCtx(over: Partial<RunContext> = {}) {
  const chunks: string[] = []
  const ctx = {
    projectRoot: workspace,
    emit: (_event: string, payload: { chunk: string }) => { chunks.push(payload.chunk) },
    ...over,
  } as unknown as RunContext
  return { ctx, chunks }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-trust-')))
  workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  // Point the resolver at the temp config rather than the developer's real one.
  process.env.CLAUDE_CONFIG_DIR = dir
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CANARY_LAB_NO_WORKSPACE_TRUST
})

const writeConfig = (config: unknown) =>
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(config))
const readConfig = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'))

describe('ensureHealWorkspaceTrusted', () => {
  it('trusts the project root — not the run directory — so every later run inherits it', () => {
    writeConfig({ projects: {} })
    const { ctx } = mkCtx()
    ensureHealWorkspaceTrusted(ctx)
    expect(Object.keys(readConfig().projects)).toEqual([workspace])
  })

  it('says what it did, and that tool approval is unchanged', () => {
    writeConfig({ projects: {} })
    const { ctx, chunks } = mkCtx()
    ensureHealWorkspaceTrusted(ctx)
    expect(chunks.join('')).toContain(workspace)
    expect(chunks.join('')).toContain('Tool approval is unchanged')
  })

  it('stays silent when trust was already in place', () => {
    writeConfig({ projects: { [workspace]: { hasTrustDialogAccepted: true } } })
    const { ctx, chunks } = mkCtx()
    ensureHealWorkspaceTrusted(ctx)
    expect(chunks).toEqual([])
  })

  it('warns — and names the prompt — when it could not write the config', () => {
    // No config file at all: the CLI has never run, so there is nothing to
    // merge into and we refuse to invent one.
    const { ctx, chunks } = mkCtx()
    ensureHealWorkspaceTrusted(ctx)
    expect(chunks.join('')).toContain('missing or unreadable')
    expect(chunks.join('')).toContain('one you trust')
  })

  it('does nothing when the opt-out env var is set', () => {
    process.env.CANARY_LAB_NO_WORKSPACE_TRUST = '1'
    writeConfig({ projects: {} })
    const { ctx, chunks } = mkCtx()
    ensureHealWorkspaceTrusted(ctx)
    expect(readConfig().projects).toEqual({})
    expect(chunks).toEqual([])
    expect(healWorkspaceTrustRoot(ctx)).toBeUndefined()
  })

  it('does nothing when the run has no project root to trust', () => {
    writeConfig({ projects: {} })
    const { ctx, chunks } = mkCtx({ projectRoot: undefined })
    ensureHealWorkspaceTrusted(ctx)
    expect(readConfig().projects).toEqual({})
    expect(chunks).toEqual([])
    expect(healWorkspaceTrustRoot(ctx)).toBeUndefined()
  })

  it('returns the project root for an invocation-scoped agent trust override', () => {
    const { ctx } = mkCtx()
    expect(healWorkspaceTrustRoot(ctx)).toBe(workspace)
  })
})
