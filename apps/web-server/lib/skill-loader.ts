import fs from 'fs'
import os from 'os'
import path from 'path'

// Walks Claude Code skill directories and returns a normalized list of skills.
// Skills live as `SKILL.md` files (or sometimes `<name>.md`) under
// `~/.claude/skills/` (user-installed) and
// `~/.claude/plugins/cache/<plugin>/skills/` (plugin-cached). Each file may
// contain a YAML frontmatter block with `name` and `description`. We parse a
// minimal subset — `key: value` pairs only, no nested YAML — which is enough
// for the recommender. Anything we cannot parse is skipped silently rather
// than failing the whole listing.

export interface SkillRecord {
  id: string
  name: string
  description: string
  source: 'user' | `plugin:${string}`
  path: string
}

export interface SkillLoaderOptions {
  roots?: SkillRoot[]
}

export interface SkillRoot {
  dir: string
  source: 'user' | `plugin:${string}`
}

export function defaultSkillRoots(homeDir: string = os.homedir()): SkillRoot[] {
  const roots: SkillRoot[] = []
  const userDir = path.join(homeDir, '.claude', 'skills')
  roots.push({ dir: userDir, source: 'user' })
  const pluginsCache = path.join(homeDir, '.claude', 'plugins', 'cache')
  if (fs.existsSync(pluginsCache)) {
    for (const entry of fs.readdirSync(pluginsCache, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillsDir = path.join(pluginsCache, entry.name, 'skills')
      if (fs.existsSync(skillsDir)) {
        roots.push({ dir: skillsDir, source: `plugin:${entry.name}` })
      }
    }
  }
  return roots
}

// Minimal YAML frontmatter parser. Supports the `--- ... ---` block at the top
// of a file and `key: value` lines (single-line strings, optionally quoted).
// Multi-line / nested YAML is treated as opaque and skipped — we only need
// `name` and `description`.
export function parseFrontmatter(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!source.startsWith('---')) return out
  const lines = source.split('\n')
  if (lines[0].trim() !== '---') return out
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return out
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let value = m[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

function stableId(source: string, file: string): string {
  const base = path.basename(file).replace(/\.md$/i, '')
  return `${source}:${base}`
}

function findSkillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  return out.sort()
}

export function loadSkills(opts: SkillLoaderOptions = {}): SkillRecord[] {
  const roots = opts.roots ?? defaultSkillRoots()
  const out: SkillRecord[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const files = findSkillFiles(root.dir)
    for (const file of files) {
      let raw = ''
      try {
        raw = fs.readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      const fm = parseFrontmatter(raw)
      const name = fm.name?.trim()
      const description = fm.description?.trim()
      if (!name || !description) continue
      const id = stableId(root.source, file)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, name, description, source: root.source, path: file })
    }
  }
  return out
}
