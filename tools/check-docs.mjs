#!/usr/bin/env node
// Contributor-docs gate: the mechanically checkable half of the audit in the
// `cl_verify-changes` skill.
//
// It exists because the "discipline only" version of that audit missed a whole
// 2.0.0's worth of drift — dead module-map paths, a heading that no anchor
// pointed at, a route attributed to the wrong file. Those are all decidable, so
// they should fail a command rather than wait for someone to notice.
//
// Two rules:
//   1. Every repo path named in backticks resolves on disk.
//   2. Every relative markdown link resolves — file AND `#anchor`.
//
// What it deliberately does NOT check: whether the prose is TRUE. A doc can
// name only live files and still describe behaviour that changed two releases
// ago. The judgement half stays in the skill.
import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const docs = ['README.md', ...readdirSync(path.join(repoRoot, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`)]

// Only paths rooted at a real top-level dir are treated as repo paths. This is
// what keeps `feature.config.cjs`, `~/.local/bin` and `npm run build` out.
const ROOTS = ['apps/', 'shared/', 'tools/', 'templates/', 'docs/', '.claude/', '.github/', 'agent-integrations/']
// Placeholders and globs are prose, not paths: `logs/runs/<runId>/`,
// `features/*/envsets/*`, `tool-groups/{reads,authoring}.ts`.
const PLACEHOLDER = /[*<>{}…]|\.\.\./

// GitHub's heading→anchor rule: lowercase, drop punctuation, spaces to hyphens.
const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')

const anchorsFor = (file) => new Set(
  readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => slug(l.replace(/^#+ /, ''))),
)

const anchors = Object.fromEntries(docs.map((f) => [f, anchorsFor(f)]))
const findings = []

for (const doc of docs) {
  const text = readFileSync(path.join(repoRoot, doc), 'utf8')
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    const at = `${doc}:${i + 1}`

    // Rule 1 — backticked repo paths exist.
    for (const [, code] of line.matchAll(/`([^`]+)`/g)) {
      const candidate = code.trim().replace(/[.,;:]$/, '').replace(/\/$/, '')
      if (!ROOTS.some((r) => candidate.startsWith(r))) continue
      if (PLACEHOLDER.test(candidate)) continue
      if (!existsSync(path.join(repoRoot, candidate))) {
        findings.push(`${at}  dead path  \`${candidate}\``)
      }
    }

    // Rule 2 — relative links resolve, anchors included.
    for (const [, link] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(link)) continue
      const [file, frag] = link.split('#')
      const target = file
        ? path.normalize(path.join(path.dirname(doc), file))
        : doc
      if (file && !existsSync(path.join(repoRoot, target))) {
        findings.push(`${at}  dead link  ${link}`)
        continue
      }
      if (frag && anchors[target] && !anchors[target].has(frag)) {
        findings.push(`${at}  dead anchor  ${link}`)
      }
    }
  })
}

if (findings.length > 0) {
  console.error(`✖ contributor docs: ${findings.length} broken reference(s)\n`)
  for (const f of findings) console.error(`  ${f}`)
  console.error('\nFix the reference, or make it a placeholder (`<runId>`, `*`) if it is prose.')
  process.exit(1)
}

console.log(`✔ contributor docs — paths, links and anchors resolve across ${docs.length} file(s)`)
