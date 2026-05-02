import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadSkills,
  parseFrontmatter,
  defaultSkillRoots,
  type SkillRoot,
} from './skill-loader'

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-skills-')))
})

function writeSkill(rootDir: string, rel: string, body: string): string {
  const full = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

const fm = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nbody text\n`

describe('parseFrontmatter', () => {
  it('returns empty object when there is no frontmatter', () => {
    expect(parseFrontmatter('hello world')).toEqual({})
  })
  it('returns empty object when first line is not exactly ---', () => {
    expect(parseFrontmatter('---x\nname: a\n---\n')).toEqual({})
  })
  it('returns empty object when closing --- is missing', () => {
    expect(parseFrontmatter('---\nname: a\n')).toEqual({})
  })
  it('parses key/value pairs and strips quotes', () => {
    const r = parseFrontmatter('---\nname: foo\ndescription: "hello world"\nother: \'q\'\n---\n')
    expect(r).toEqual({ name: 'foo', description: 'hello world', other: 'q' })
  })
  it('skips lines that are not key: value', () => {
    const r = parseFrontmatter('---\nname: foo\nrandom line\n  - bullet\ndesc: ok\n---\n')
    expect(r).toEqual({ name: 'foo', desc: 'ok' })
  })
})

describe('loadSkills', () => {
  it('returns empty when no roots exist', () => {
    expect(loadSkills({ roots: [{ dir: path.join(tmp, 'nope'), source: 'user' }] })).toEqual([])
  })
  it('loads skills from a single user root', () => {
    const root = path.join(tmp, 'user')
    writeSkill(root, 'a.md', fm('alpha', 'do alpha things'))
    writeSkill(root, 'sub/b.md', fm('beta', 'do beta things'))
    const out = loadSkills({ roots: [{ dir: root, source: 'user' }] })
    expect(out.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
    expect(out.every((s) => s.source === 'user')).toBe(true)
    expect(out[0].id).toMatch(/^user:/)
  })
  it('skips files without name or description', () => {
    const root = path.join(tmp, 'user')
    writeSkill(root, 'good.md', fm('good', 'desc'))
    writeSkill(root, 'bad-noframe.md', '# no frontmatter')
    writeSkill(root, 'bad-partial.md', '---\nname: only\n---\n')
    const out = loadSkills({ roots: [{ dir: root, source: 'user' }] })
    expect(out.map((s) => s.name)).toEqual(['good'])
  })
  it('loads from multiple roots and tags plugin source', () => {
    const u = path.join(tmp, 'u')
    const p = path.join(tmp, 'p')
    writeSkill(u, 'one.md', fm('one', 'd'))
    writeSkill(p, 'two.md', fm('two', 'd'))
    const roots: SkillRoot[] = [
      { dir: u, source: 'user' },
      { dir: p, source: 'plugin:thing' },
    ]
    const out = loadSkills({ roots })
    expect(out.find((s) => s.name === 'two')!.source).toBe('plugin:thing')
  })
  it('dedupes skills with the same id across roots', () => {
    const u = path.join(tmp, 'u')
    writeSkill(u, 'dup.md', fm('alpha', 'first'))
    writeSkill(u, 'sub/dup.md', fm('alpha', 'second'))
    const out = loadSkills({ roots: [{ dir: u, source: 'user' }] })
    // Same basename → same id → second wins or first wins, but only one
    // entry should be present.
    expect(out.length).toBe(1)
  })
  it('ignores non-md files', () => {
    const root = path.join(tmp, 'user')
    writeSkill(root, 'good.md', fm('good', 'desc'))
    fs.writeFileSync(path.join(root, 'README.txt'), 'hi')
    const out = loadSkills({ roots: [{ dir: root, source: 'user' }] })
    expect(out.length).toBe(1)
  })
  it('skips skill roots whose directory does not exist', () => {
    const out = loadSkills({ roots: [{ dir: path.join(tmp, 'never-existed'), source: 'user' }] })
    expect(out).toEqual([])
  })

  it('survives unreadable files (silently skips them)', () => {
    const root = path.join(tmp, 'user')
    writeSkill(root, 'good.md', fm('good', 'desc'))
    // Simulate readFileSync failure by pointing at a directory named *.md.
    const dirAsMd = path.join(root, 'weird.md')
    fs.mkdirSync(dirAsMd)
    const out = loadSkills({ roots: [{ dir: root, source: 'user' }] })
    expect(out.map((s) => s.name)).toEqual(['good'])
  })
})

describe('defaultSkillRoots', () => {
  it('returns the user dir plus discovered plugin caches', () => {
    const home = path.join(tmp, 'home')
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache', 'pluginA', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache', 'pluginB'), { recursive: true })
    // pluginB has no skills/ subdir → should be skipped
    const roots = defaultSkillRoots(home)
    expect(roots[0].source).toBe('user')
    const pluginRoots = roots.filter((r) => r.source.startsWith('plugin:'))
    expect(pluginRoots.map((r) => r.source)).toEqual(['plugin:pluginA'])
  })
  it('returns just the user root when no plugins cache exists', () => {
    const home = path.join(tmp, 'home2')
    const roots = defaultSkillRoots(home)
    expect(roots).toHaveLength(1)
    expect(roots[0].source).toBe('user')
  })
})
