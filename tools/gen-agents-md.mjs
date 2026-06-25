import fs from 'node:fs'
import path from 'node:path'

// AGENTS.md is generated from CLAUDE.md so the two never drift. CLAUDE.md is the
// single source of truth; this script reframes it for Codex (and any agent that
// reads AGENTS.md) — same content, Codex paths. Run `npm run gen:agents` after
// editing CLAUDE.md, or rely on the build (`npm run build`) to regenerate it.
// `--check` exits non-zero if AGENTS.md is stale (used by smoke/verify).

const repoRoot = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(repoRoot, 'CLAUDE.md')
const targetPath = path.join(repoRoot, 'AGENTS.md')

const BANNER = `<!-- GENERATED FROM CLAUDE.md — DO NOT EDIT.
     Run \`npm run gen:agents\` after editing CLAUDE.md (the build does this too). -->
`

function render(source) {
  const body = source
    .replace('# Canary Lab — Contributor Notes', '# Canary Lab — Agent Notes')
    .replaceAll('.claude/skills', '.codex/skills')
  return `${BANNER}\n${body}`
}

const expected = render(fs.readFileSync(sourcePath, 'utf8'))

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : ''
  if (actual !== expected) {
    console.error('AGENTS.md is out of date with CLAUDE.md. Run `npm run gen:agents`.')
    process.exit(1)
  }
  process.exit(0)
}

fs.writeFileSync(targetPath, expected)
console.log('Generated AGENTS.md from CLAUDE.md')
