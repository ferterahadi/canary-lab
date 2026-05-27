import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Stub the MCP refresh so upgrade tests never shell out to the real
// claude/codex CLIs (which would mutate the developer's actual config).
const mcpRefreshMocks = vi.hoisted(() => ({ refreshCanaryLabMcp: vi.fn() }))
vi.mock('./mcp-refresh', () => ({ refreshCanaryLabMcp: mcpRefreshMocks.refreshCanaryLabMcp }))

import { extractManagedBlock, applyManagedBlock, applyGitignoreRules, main } from './upgrade'
import { readWorkspaceRegistry } from '../shared/runtime/workspace-registry'

const tmpDirs: string[] = []
function mkProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-up-'))
  tmpDirs.push(dir)
  const root = fs.realpathSync(dir)
  fs.mkdirSync(path.join(root, 'features'))
  return root
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-home-'))
  tmpDirs.push(home)
  vi.stubEnv('CANARY_LAB_AGENT_HOME', home)
  mcpRefreshMocks.refreshCanaryLabMcp.mockClear()
})

const START = '<!-- managed:canary-lab:start -->'
const END = '<!-- managed:canary-lab:end -->'
const BLOCK = `${START}\nmanaged body\n${END}`

describe('extractManagedBlock', () => {
  it('returns the marker-bounded block (inclusive)', () => {
    const content = `prefix\n${BLOCK}\nsuffix`
    expect(extractManagedBlock(content)).toBe(BLOCK)
  })

  it('returns null when either marker is missing', () => {
    expect(extractManagedBlock('no markers here')).toBeNull()
    expect(extractManagedBlock(`only ${START}`)).toBeNull()
    expect(extractManagedBlock(`only ${END}`)).toBeNull()
  })
})

describe('applyManagedBlock', () => {
  const NEW_BLOCK = `${START}\nnew body\n${END}`

  it('Case 1: surgical replace preserves content before and after markers', () => {
    const existing = `HEADER\n\n${BLOCK}\n\nFOOTER`
    const result = applyManagedBlock(existing, NEW_BLOCK, 'CLAUDE.md')
    expect(result).toBe(`HEADER\n\n${NEW_BLOCK}\n\nFOOTER`)
  })

  it('Case 2: legacy CLAUDE.md signature triggers full replace', () => {
    const existing = '# Canary Lab Project Notes\nold body\nold body 2\n'
    const result = applyManagedBlock(existing, NEW_BLOCK, 'CLAUDE.md')
    expect(result).toBe(`${NEW_BLOCK}\n`)
  })

  it('Case 2: legacy AGENTS.md signature triggers full replace', () => {
    const existing = '# Canary Lab Agent Guide\nold'
    const result = applyManagedBlock(existing, NEW_BLOCK, 'AGENTS.md')
    expect(result).toBe(`${NEW_BLOCK}\n`)
  })

  it('Case 3: unknown content without markers appends with a blank line', () => {
    const existing = '# My Custom Doc\n\nHand-written stuff.'
    const result = applyManagedBlock(existing, NEW_BLOCK, 'CLAUDE.md')
    expect(result).toBe(`# My Custom Doc\n\nHand-written stuff.\n\n${NEW_BLOCK}\n`)
  })

  it('Case 3: empty existing content emits block plus trailing newline, no leading blank line', () => {
    expect(applyManagedBlock('', NEW_BLOCK, 'CLAUDE.md')).toBe(`${NEW_BLOCK}\n`)
  })

  it('Case 3: whitespace-only existing content is treated as empty', () => {
    expect(applyManagedBlock('   \n  ', NEW_BLOCK, 'CLAUDE.md')).toBe(`${NEW_BLOCK}\n`)
  })

  it('unknown relPath never triggers legacy replacement', () => {
    const existing = '# Canary Lab Project Notes\nold'
    const result = applyManagedBlock(existing, NEW_BLOCK, 'README.md')
    expect(result).toBe(`# Canary Lab Project Notes\nold\n\n${NEW_BLOCK}\n`)
  })
})

describe('applyGitignoreRules', () => {
  it('appends missing envset value rules while preserving existing content', () => {
    const existing = 'node_modules/\n.env\n'

    expect(applyGitignoreRules(existing)).toBe(
      [
        'node_modules/',
        '.env',
        '',
        '# Canary Lab envset values may contain secrets.',
        '# envsets.config.json files are outside these patterns, so they stay trackable.',
        'envsets/*/*',
        'features/*/envsets/*/*',
        '',
      ].join('\n'),
    )
  })

  it('does not rewrite when both envset value rules already exist', () => {
    const existing = [
      'node_modules/',
      'envsets/*/*',
      'features/*/envsets/*/*',
      '',
    ].join('\n')

    expect(applyGitignoreRules(existing)).toBe(existing)
  })
})

describe("main (upgrade orchestration)", () => {
  it("exits silently when no project root (no features/ anywhere)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cl-up-noroot-"))
    tmpDirs.push(root)
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await main(["--silent"])
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("removes project-local skill files, removes legacy agent docs, and injects postinstall", async () => {
    const root = mkProjectRoot()
    const home = process.env.CANARY_LAB_AGENT_HOME!
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: {} }))
    for (const rel of [
      ".claude/skills/env-import.md",
      ".claude/skills/canary-lab-feature.md",
      ".codex/env-import.md",
      ".codex/canary-lab-feature.md",
    ]) {
      const target = path.join(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, "stale project-local skill")
    }
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    expect(fs.existsSync(path.join(root, ".claude/skills/env-import.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".claude/skills/canary-lab-feature.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/env-import.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/canary-lab-feature.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".claude/skills/self-fixing-loop.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".claude/skills/heal-loop.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/self-fixing-loop.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/heal-loop.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false)

    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))
    expect(pkg.scripts.postinstall).toBe("canary-lab upgrade --silent")
    expect(readWorkspaceRegistry(home).workspaces[0].path).toBe(root)
  })

  it("re-points already-configured MCP clients on upgrade", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    expect(mcpRefreshMocks.refreshCanaryLabMcp).toHaveBeenCalledTimes(1)
  })

  it("refreshes only existing user-level agent integrations on upgrade", async () => {
    const root = mkProjectRoot()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agent-upgrade-'))
    tmpDirs.push(home)
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.stubEnv("CANARY_LAB_AGENT_HOME", home)
    vi.spyOn(console, "log").mockImplementation(() => {})

    const staleSkill = path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md')
    fs.mkdirSync(path.dirname(staleSkill), { recursive: true })
    fs.writeFileSync(staleSkill, 'stale prompt')

    await main([])

    expect(fs.readFileSync(staleSkill, 'utf-8')).toContain('wait_for_heal_task')
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(false)
  })

  it("adds envset value rules to an existing project .gitignore", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n")
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf-8")
    expect(gitignore).toContain("node_modules/")
    expect(gitignore).toContain("envsets/*/*")
    expect(gitignore).toContain("features/*/envsets/*/*")
    expect(gitignore).not.toContain("!envsets/*/*")
    expect(gitignore).not.toContain("!features/*/envsets/*/*")
  })

  it("does not recreate deprecated project-local skill files", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    expect(fs.existsSync(path.join(root, ".claude/skills/env-import.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".claude/skills/canary-lab-feature.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/env-import.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".codex/canary-lab-feature.md"))).toBe(false)
  })

  it("removes deprecated heal skill files from projects scaffolded by older canary-lab versions", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    // Simulate a 0.9.x install: the four heal skill files are present on disk.
    const deprecated = [
      ".claude/skills/heal-loop.md",
      ".claude/skills/self-fixing-loop.md",
      ".codex/heal-loop.md",
      ".codex/self-fixing-loop.md",
    ]
    for (const rel of deprecated) {
      const p = path.join(root, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, "stale content from a previous version")
    }

    await main([])

    for (const rel of deprecated) {
      expect(fs.existsSync(path.join(root, rel))).toBe(false)
    }
  })

  it("removes managed agent doc blocks while preserving user notes", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    const claudePath = path.join(root, "CLAUDE.md")
    fs.writeFileSync(claudePath, `# My notes\ncustom stuff\n\n${BLOCK}\n`)
    fs.writeFileSync(path.join(root, "AGENTS.md"), `${BLOCK}\n`)

    await main([])
    const after = fs.readFileSync(claudePath, "utf-8")
    expect(after).toBe("# My notes\ncustom stuff\n")
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false)
  })

  it("does not create agent docs for personal wiki settings on upgrade", async () => {
    const root = mkProjectRoot()
    const wiki = path.join(root, "wiki")
    fs.mkdirSync(wiki)
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.writeFileSync(
      path.join(root, "canary-lab.config.json"),
      JSON.stringify({ personalWikiPath: wiki }, null, 2) + "\n",
    )
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false)
  })

  it("does not crash on malformed package.json", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.writeFileSync(path.join(root, "package.json"), "not-json")
    vi.spyOn(console, "log").mockImplementation(() => {})
    await expect(main([])).resolves.toBeUndefined()
    expect(fs.readFileSync(path.join(root, "package.json"), "utf-8")).toBe("not-json")
  })

  it("--silent suppresses all console.log output", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await main(["--silent"])
    expect(logSpy).not.toHaveBeenCalled()
  })
})
