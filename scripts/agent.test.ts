import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { install, installOrRefresh, main, refreshInstalled } from './agent'

describe('canary-lab agent install', () => {
  it('dry-run prints planned copies and MCP snippets without writing files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-dry-'))
    const lines: string[] = []
    install('all', { homeDir: home, dryRun: true, log: (line) => lines.push(line) })

    expect(lines.join('\n')).toContain('[dry-run] copy Codex skill')
    expect(lines.join('\n')).toContain('npx -y canary-lab mcp --profile full')
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false)
  })

  it('installs codex skill and plugin bundle', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-install-'))
    install('codex', { homeDir: home, log: () => {} })

    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(true)
  })

  it('refuses to overwrite unless --force is used', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-overwrite-'))
    install('claude', { homeDir: home, log: () => {} })
    expect(() => install('claude', { homeDir: home, log: () => {} })).toThrow(/--force/)
    expect(() => install('claude', { homeDir: home, force: true, log: () => {} })).not.toThrow()
  })

  it('refreshes only installed integrations whose content differs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-refresh-'))
    const lines: string[] = []
    install('codex', { homeDir: home, log: () => {} })
    const skillPath = path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md')
    fs.writeFileSync(skillPath, 'stale prompt')
    fs.rmSync(path.join(home, '.canary-lab'), { recursive: true, force: true })

    expect(refreshInstalled('all', { homeDir: home, log: (line) => lines.push(line) })).toBe(1)

    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('wait_for_heal_task')
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(false)
    expect(lines.join('\n')).toContain('Updated Codex skill')
  })

  it('installOrRefresh installs missing integrations and updates stale managed files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-setup-'))
    const lines: string[] = []
    installOrRefresh('codex', { homeDir: home, log: (line) => lines.push(line) })
    const skillPath = path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md')
    fs.writeFileSync(skillPath, 'stale prompt')

    expect(installOrRefresh('codex', { homeDir: home, log: (line) => lines.push(line) })).toBe(1)

    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('Workspace Bootstrap')
    expect(lines.join('\n')).toContain('Installed Codex skill')
    expect(lines.join('\n')).toContain('Updated Codex skill')
  })

  it('instructs agents to verify fixes with signal_run instead of start_run', () => {
    const assets = path.resolve(__dirname, '..', 'agent-integrations')
    const skillPaths = [
      path.join(assets, 'codex', 'skills', 'canary-lab', 'SKILL.md'),
      path.join(assets, 'claude', 'skills', 'canary-lab', 'SKILL.md'),
      path.join(assets, 'plugin', 'canary-lab', 'skills', 'canary-lab', 'SKILL.md'),
    ]

    for (const skillPath of skillPaths) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('never call `start_run` to verify')
      expect(body).toContain('Workspace Bootstrap')
      expect(body).toContain('~/.canary-lab/workspaces.json')
      expect(body).toContain('/mcp/health')
      expect(body).toContain('do not pass `--port`')
      expect(body).toContain('Do not reflexively call `list_features` or `list_runs` after health')
      expect(body).toContain('For random or new feature creation, call `create_feature` directly with a unique feature name')
      expect(body).toContain('context.healPrompt.startHere')
      expect(body).toContain('get_run_snapshot')
      expect(body).toContain('`signal_run` with `hypothesis` and `fixDescription`, then `wait_for_heal_task`')
      expect(body).toContain('Use `force_new` only when the user explicitly wants a separate concurrent run')
	      expect(body).toContain('cancel_heal')
	      expect(body).toContain('continued by default')
	      expect(body).toContain('remaining-test mode')
	      expect(body).toContain('failed tests first, then skipped tests, then pending/not-run tests')
	      expect(body).toContain('do not tell the user no test filter exists')
	    }
	  })

  it('leaves up-to-date installed integrations untouched during refresh', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-refresh-current-'))
    install('codex', { homeDir: home, log: () => {} })
    const skillPath = path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md')
    const before = fs.statSync(skillPath).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(refreshInstalled('codex', { homeDir: home, log: () => {} })).toBe(0)

    expect(fs.statSync(skillPath).mtimeMs).toBe(before)
  })

  it('main validates install target', async () => {
    const errors: string[] = []
    const exits: number[] = []
    await main(['install', 'bogus'], {
      error: (line) => errors.push(line),
      exit: (code) => { exits.push(code) },
    })
    expect(exits).toEqual([1])
    expect(errors[0]).toContain('Usage: canary-lab agent install')
  })
})
