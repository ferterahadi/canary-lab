import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadSabotageSkills,
  loadBundledSabotageSkills,
  SABOTAGE_SKILLS_DIR,
  sabotageSkillsForFeature,
  type SabotageSkill,
} from './skills'

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-skills-')))
})

const MD = `# Broken delete contract

**Level:** medium destruction

## Description

Break an API contract so the response looks OK but the state is wrong.

## Sabotage instructions

Break the DELETE handler so it returns 204 but does not remove the item.

## Constraints

- Edit only scripts/**.
`

function writeSkill(name: string, meta: Record<string, unknown>, md: string = MD): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
  fs.writeFileSync(path.join(dir, 'skill.md'), md)
}

describe('loadSabotageSkills', () => {
  it('parses each skill folder: meta fields, picker description, and agent recipe', () => {
    writeSkill('broken-delete-contract', {
      name: 'broken-delete-contract',
      title: 'Broken delete contract',
      level: 'med',
      summary: 'an API contract lies',
      appliesTo: ['example_todo_api'],
    })
    const skills = loadSabotageSkills(root)
    expect(skills).toHaveLength(1)
    const s = skills[0]
    expect(s.name).toBe('broken-delete-contract')
    expect(s.title).toBe('Broken delete contract')
    expect(s.level).toBe('med')
    expect(s.summary).toBe('an API contract lies')
    expect(s.appliesTo).toEqual(['example_todo_api'])
    expect(s.description).toContain('Break an API contract')
    // recipe starts at the instructions and runs to EOF (so it carries the
    // Constraints / no-cheat block), but NOT the picker Description above it.
    expect(s.recipe).toContain('Break the DELETE handler')
    expect(s.recipe).toContain('Edit only scripts')
    expect(s.recipe).not.toContain('## Description')
  })

  it('sorts skills by destruction level (min → med → max)', () => {
    writeSkill('c', { name: 'c', title: 'C', level: 'max', summary: '', appliesTo: [] })
    writeSkill('a', { name: 'a', title: 'A', level: 'min', summary: '', appliesTo: [] })
    writeSkill('b', { name: 'b', title: 'B', level: 'med', summary: '', appliesTo: [] })
    expect(loadSabotageSkills(root).map((s) => s.level)).toEqual(['min', 'med', 'max'])
  })

  it('skips directories without a meta.json', () => {
    fs.mkdirSync(path.join(root, 'junk'), { recursive: true })
    fs.writeFileSync(path.join(root, 'junk', 'readme.txt'), 'not a skill')
    writeSkill('real', { name: 'real', title: 'R', level: 'min', summary: '', appliesTo: [] })
    expect(loadSabotageSkills(root).map((s) => s.name)).toEqual(['real'])
  })

  it('returns [] when the skills directory does not exist', () => {
    expect(loadSabotageSkills(path.join(root, 'missing'))).toEqual([])
  })
})

describe('loadBundledSabotageSkills', () => {
  it('resolves the webserver-bundled skills (one per level) from prompts/sabotage-skills', () => {
    expect(SABOTAGE_SKILLS_DIR.endsWith(path.join('prompts', 'sabotage-skills'))).toBe(true)
    const names = loadBundledSabotageSkills().map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining([
      'off-by-one',
      'broken-delete-contract',
      'multi-failure-cascade',
    ]))
  })

  it('bundled skills apply to every feature and carry a non-empty recipe', () => {
    for (const s of loadBundledSabotageSkills()) {
      expect(s.appliesTo.length === 0 || s.appliesTo.includes('*')).toBe(true)
      expect(s.recipe.length).toBeGreaterThan(0)
    }
  })
})

describe('sabotageSkillsForFeature', () => {
  const skill = (name: string, appliesTo: string[]): SabotageSkill => ({
    name,
    title: name,
    level: 'min',
    summary: '',
    appliesTo,
    description: '',
    recipe: '',
    dir: '',
  })

  it('keeps only skills whose appliesTo includes the feature', () => {
    const skills = [skill('a', ['example_todo_api']), skill('b', ['other'])]
    expect(sabotageSkillsForFeature(skills, 'example_todo_api').map((s) => s.name)).toEqual(['a'])
  })

  it('treats empty appliesTo or "*" as applies-to-all', () => {
    const skills = [skill('all1', []), skill('all2', ['*']), skill('specific', ['other'])]
    expect(sabotageSkillsForFeature(skills, 'example_todo_api').map((s) => s.name)).toEqual([
      'all1',
      'all2',
    ])
  })
})
