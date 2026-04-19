import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractManagedBlock, applyManagedBlock, main } from './upgrade'

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

describe("main (upgrade orchestration)", () => {
  it("exits silently when no project root (no features/ anywhere)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cl-up-noroot-"))
    tmpDirs.push(root)
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await main(["--silent"])
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("copies FULLY_MANAGED files, applies MARKER_MANAGED, injects postinstall", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: {} }))
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])

    expect(fs.existsSync(path.join(root, ".claude/skills/self-fixing-loop.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".claude/skills/env-import.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".claude/skills/heal-loop.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".codex/self-fixing-loop.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".codex/env-import.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".codex/heal-loop.md"))).toBe(true)

    const claudeMd = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8")
    expect(claudeMd).toContain("<!-- managed:canary-lab:start -->")
    expect(claudeMd).toContain("<!-- managed:canary-lab:end -->")

    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))
    expect(pkg.scripts.postinstall).toBe("canary-lab upgrade --silent")
  })

  it("does not rewrite FULLY_MANAGED file if content already matches template", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])
    const target = path.join(root, ".claude/skills/self-fixing-loop.md")
    const mtime1 = fs.statSync(target).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    await main([])
    const mtime2 = fs.statSync(target).mtimeMs
    expect(mtime2).toBe(mtime1)
  })

  it("preserves user content around markers across upgrades (surgical replace)", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main([])
    const claudePath = path.join(root, "CLAUDE.md")
    const withUserNotes =
      fs.readFileSync(claudePath, "utf-8") + "\n\n# My notes\ncustom stuff\n"
    fs.writeFileSync(claudePath, withUserNotes)

    await main([])
    const after = fs.readFileSync(claudePath, "utf-8")
    expect(after).toContain("# My notes")
    expect(after).toContain("custom stuff")
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
