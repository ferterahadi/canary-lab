import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { install, installOrRefresh, main, refreshInstalled, refreshAgentIntegrationsQuietly } from './agent'

describe('canary-lab agent install', () => {
  it('dry-run prints planned copies and MCP snippets without writing files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-dry-'))
    const lines: string[] = []
    install('all', { homeDir: home, dryRun: true, log: (line) => lines.push(line) })

    expect(lines.join('\n')).toContain('[dry-run] copy Codex skill')
    expect(lines.join('\n')).toContain('npx -y canary-lab mcp --profile compact')
    expect(lines.join('\n')).toContain('"alwaysLoad": true')
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

    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('start_flight')
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(false)
    expect(lines.join('\n')).toContain('Updated Codex skill')
  })

  it('refresh gives a client that has any skill the whole current set', () => {
    // Reproduces the pre-2.0.0 shape exactly: one `canary-lab` skill per client
    // and nothing else, because that release only ever shipped one. An op-wise
    // refresh (skip every destination that does not exist) leaves it that way
    // while reporting success, so the six skills the refreshed hub skill points
    // at are never written — assert on the directory listing, not the count,
    // since a count is what made that failure invisible in the first place.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-split-'))
    for (const client of ['.codex', '.claude'] as const) {
      const legacy = path.join(home, client, 'skills', 'canary-lab')
      fs.mkdirSync(legacy, { recursive: true })
      fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'pre-2.0.0 skill')
    }

    refreshInstalled('all', { homeDir: home, log: () => {} })

    const packaged = fs
      .readdirSync(path.resolve(__dirname, '..', '..', 'agent-integrations', 'claude', 'skills'))
      .sort()
    expect(packaged.length).toBeGreaterThan(1)
    expect(fs.readdirSync(path.join(home, '.claude', 'skills')).sort()).toEqual(packaged)
    expect(fs.readdirSync(path.join(home, '.codex', 'skills')).sort()).toEqual(packaged)
    // The plugin bundle is its own group: nothing installed it, so it stays out.
    expect(fs.existsSync(path.join(home, '.canary-lab'))).toBe(false)
  })

  it('refresh leaves a client with nothing installed entirely alone', () => {
    // The other half of the group rule. Widening the refresh must not turn it
    // into an installer for a client the user never opted in on — that stays
    // explicit via `canary-lab setup`.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-optin-'))
    const legacy = path.join(home, '.codex', 'skills', 'canary-lab')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'pre-2.0.0 skill')

    refreshInstalled('all', { homeDir: home, log: () => {} })

    expect(fs.readdirSync(path.join(home, '.codex', 'skills')).length).toBeGreaterThan(1)
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
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

  it('ships the load-bearing workflow instructions across every agent surface', () => {
    const assets = path.resolve(__dirname, '..', '..', 'agent-integrations')
    const mirrors = (skill: string) => [
      path.join(assets, 'codex', 'skills', skill, 'SKILL.md'),
      path.join(assets, 'claude', 'skills', skill, 'SKILL.md'),
      path.join(assets, 'plugin', 'canary-lab', 'skills', skill, 'SKILL.md'),
    ]

    const skillNames = fs.readdirSync(path.join(assets, 'claude', 'skills')).sort()
    expect(skillNames).toEqual([
      'canary-lab',
      'canary-lab-author',
      'canary-lab-coverage',
      'canary-lab-export',
      'canary-lab-portify',
      'canary-lab-run',
      'canary-lab-verify',
    ])
    const allSkillPaths = skillNames.flatMap(mirrors)
    expect(allSkillPaths).toHaveLength(21)
    for (const skillPath of allSkillPaths) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('mcp__Canary_Lab__exec')
      expect(body).toContain('exact `command` value')
      expect(body).toContain(
        '{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}',
      )
      expect(body).toContain("This is the envelope shape, not every command's complete schema")
      expect(body).toContain('only `exec` is public')
      expect(body).not.toContain('plugin connects with `full`')
    }
    for (const skill of skillNames) {
      expect(fs.readFileSync(mirrors(skill)[0])).toEqual(fs.readFileSync(mirrors(skill)[1]))
    }

    // The run/heal loop rules live in the canary-lab-run skill since the split.
    for (const skillPath of mirrors('canary-lab-run')) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('never call `start_run` to verify')
      expect(body).toContain('The signal requests runner verification')
      expect(body).toContain('Do not start services or run Playwright')
      expect(body).toContain('Workspace Bootstrap')
      expect(body).toContain('~/.canary-lab/workspaces.json')
      expect(body).toContain('/mcp/health')
      expect(body).toContain('context.healPrompt.startHere')
      expect(body).toContain('get_run_snapshot')
      expect(body).toContain('`signal_run` with `hypothesis` and `fixDescription`, then `wait_for_heal_task`')
      expect(body).toContain('Use `force_new` only when the user explicitly wants a separate concurrent run')
      expect(body).toContain('cancel_heal')
      expect(body).toContain('continued by default')
      expect(body).toContain('remaining-test mode')
      expect(body).toContain('failed tests first, then skipped tests, then pending/not-run tests')
      expect(body).toContain('do not tell the user no test filter exists')
      expect(body).toContain('/canary-lab-export <runId>')
      expect(body).toContain('Do not substitute `npx canary-lab export`')
    }

    // A run handoff names its exact run, while Getting Started may still name
    // a feature. The export skill must resolve both without guessing a newer run.
    for (const skillPath of mirrors('canary-lab-export')) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('/canary-lab-export <suite-or-run-id>')
      expect(body).toContain('Try `get_run(argument)` first')
      expect(body).toContain('Only a `run not found` result')
    }

    // Authoring rules live in canary-lab-author.
    for (const skillPath of mirrors('canary-lab-author')) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('Do not reflexively call `list_features` or `list_runs` after health')
      expect(body).toContain('For random or new feature creation, call `create_feature` directly with a unique feature name')
    }

    // The Getting Started card promises a workflow, not a cached report. A
    // fresh scaffold already has a fresh 50% ledger, so this instruction is
    // what makes the agent mint the externally-owned job the UI can surface.
    for (const skillPath of mirrors('canary-lab-coverage')) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('An explicit `/canary-lab-coverage <suite>` invocation is **execution mode**')
      expect(body).toContain('call `start_external_coverage` even')
      expect(body).toContain('when `state.coverage` is `"fresh"`')
      expect(body).toContain("Starting that job is what makes the external agent's ownership")
      expect(body).toContain('`start_external_coverage(feature, session_id)`')
      expect(body).toContain('you MUST call\n`get_feature_coverage(feature)` before reporting')
    }

    // The flight entry point keeps the full bootstrap (incl. the --port note).
    for (const skillPath of mirrors('canary-lab')) {
      const body = fs.readFileSync(skillPath, 'utf-8')
      expect(body).toContain('start_flight')
      expect(body).toContain('respond_flight_checkpoint')
      expect(body).toContain('do not pass `--port`')
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

describe('refreshAgentIntegrationsQuietly temp-install guard', () => {
  // The installed skills are GLOBAL. A `ui` booted from a demo/smoke install under the
  // temp dir overwrote the user's ~/.claude skills with whatever that throwaway tarball
  // carried — observed live delivering a mid-edit skill file built from a dirty tree.
  it('installs nothing when the running install is under the temp dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-home-'))
    const tempCli = path.join(os.tmpdir(), 'canary-lab-demo-abc', 'demo-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js')
    const messages: string[] = []
    try {
      expect(refreshAgentIntegrationsQuietly({ homeDir: home, cliPath: tempCli, log: (m) => messages.push(m) })).toBe(0)
      // Nothing written at all — not even an empty skills dir.
      expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false)
      expect(messages.join(' ')).toContain('temp directory')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('refreshes from a durable install path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-home-'))
    try {
      // Seeded AND made stale. `refreshInstalled` skips an installed copy that already
      // matches the packaged asset, so a pristine install refreshes zero — this test
      // would then pass even if the guard had wrongly short-circuited. Introducing drift
      // is what makes a non-zero count the observable proof that the refresh ran.
      install('claude', { homeDir: home, log: () => {} })
      const stale = path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md')
      fs.writeFileSync(stale, 'stale content from an older version\n')
      const n = refreshAgentIntegrationsQuietly({
        homeDir: home,
        cliPath: '/Users/x/Documents/canary-lab-workspace/node_modules/canary-lab/dist/scripts/cli.js',
        log: () => {},
      })
      expect(n).toBeGreaterThan(0)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
