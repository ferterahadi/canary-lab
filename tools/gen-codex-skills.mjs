import fs from 'node:fs'
import path from 'node:path'

// .codex/skills/ is generated from .claude/skills/ so Codex and Claude read the
// same contributor conventions. `.claude/skills/` is the single source of truth;
// this script mirrors it for Codex (same content, Codex paths), the way
// gen-agents-md.mjs mirrors CLAUDE.md into AGENTS.md. Run `npm run gen:skills`
// after adding or editing a skill, or rely on the build (`npm run build`).
// `--check` exits non-zero if .codex/skills is stale (used by smoke:pack).

const repoRoot = path.resolve(import.meta.dirname, '..')
const sourceDir = path.join(repoRoot, '.claude', 'skills')
const targetDir = path.join(repoRoot, '.codex', 'skills')

// Local-only and gitignored (`.gitignore`: `.claude/skills/cl_apply-local/`). It
// overrides a shipped hard rule for one machine, so it must never be copied into
// a tracked directory. CLAUDE.md still *describes* the opt-in — that prose has no
// `.claude/skills/…` path in it, so it generates no dead link in AGENTS.md.
const EXCLUDED = new Set(['cl_apply-local'])

const BANNER = `<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run \`npm run gen:skills\` after editing the source skill (the build does this too). -->
`

function render(source, relPath) {
  const body = source.replaceAll('.claude/skills', '.codex/skills')
  if (!relPath.endsWith('.md')) return body
  // YAML frontmatter has to stay the first thing in the file — skill loaders parse
  // it before anything else — so the banner goes after the closing delimiter, not
  // above it like AGENTS.md's.
  const close = body.startsWith('---\n') ? body.indexOf('\n---\n', 3) : -1
  if (close === -1) return `${BANNER}\n${body}`
  const cut = close + '\n---\n'.length
  return `${body.slice(0, cut)}\n${BANNER}${body.slice(cut)}`
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)]
  })
}

function renderAll() {
  const rendered = new Map()
  for (const name of fs.readdirSync(sourceDir).sort()) {
    if (EXCLUDED.has(name)) continue
    const skillDir = path.join(sourceDir, name)
    if (!fs.statSync(skillDir).isDirectory()) continue
    for (const rel of walk(skillDir)) {
      const source = fs.readFileSync(path.join(skillDir, rel), 'utf8')
      rendered.set(path.join(name, rel), render(source, rel))
    }
  }
  return rendered
}

const expected = renderAll()

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(targetDir) ? walk(targetDir) : []
  const stale = actual.filter((rel) => !expected.has(rel))
  const drifted = [...expected.keys()].filter((rel) => {
    const full = path.join(targetDir, rel)
    return !fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== expected.get(rel)
  })
  if (stale.length > 0 || drifted.length > 0) {
    console.error('.codex/skills is out of date with .claude/skills. Run `npm run gen:skills`.')
    for (const rel of stale) console.error(`  no longer in source: ${rel}`)
    for (const rel of drifted) console.error(`  missing or changed:  ${rel}`)
    process.exit(1)
  }
  process.exit(0)
}

fs.rmSync(targetDir, { recursive: true, force: true })
for (const [rel, content] of expected) {
  const full = path.join(targetDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
console.log(`Generated ${expected.size} file(s) in .codex/skills from .claude/skills`)
