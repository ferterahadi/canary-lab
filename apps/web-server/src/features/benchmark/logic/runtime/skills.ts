import fs from 'fs'
import path from 'path'
import type { SabotageLevel } from './types'

// Loads the sabotage-skill folders (meta.json + skill.md). These ship WITH the
// webserver under `apps/web-server/prompts/sabotage-skills/` (like the other
// prompts the server reads) — not the scaffold — so they're Canary-controlled
// and upgrade with the package. Pure I/O: `loadSabotageSkills(dir)` reads any
// dir (used by tests); `loadBundledSabotageSkills()` reads the bundled set.
// The picker reads `summary`/`description`; the sabotage agent gets `recipe`.

export interface SabotageSkill {
  name: string
  title: string
  level: SabotageLevel
  summary: string
  /** Feature names this skill applies to. Empty or `['*']` = all features. */
  appliesTo: string[]
  /** The "## Description" section of skill.md — shown in the picker. */
  description: string
  /** "## Sabotage instructions" → EOF (carries the Constraints/no-cheat block).
   *  This is the prompt body handed to the sabotage agent. */
  recipe: string
  dir: string
}

const LEVEL_ORDER: Record<SabotageLevel, number> = { min: 0, med: 1, max: 2 }

function normalizeLevel(value: unknown): SabotageLevel {
  return value === 'min' || value === 'max' ? value : 'med'
}

/** Body of a `## <heading>` section, up to the next `## ` heading or EOF. */
function section(md: string, heading: string): string {
  const lines = md.split('\n')
  const want = `## ${heading.toLowerCase()}`
  const start = lines.findIndex((l) => l.trim().toLowerCase() === want)
  if (start === -1) return ''
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n').trim()
}

/** Everything from a `## <heading>` to EOF (keeps later subheadings inline). */
function fromHeadingToEnd(md: string, heading: string): string {
  const lines = md.split('\n')
  const want = `## ${heading.toLowerCase()}`
  const start = lines.findIndex((l) => l.trim().toLowerCase() === want)
  if (start === -1) return ''
  return lines.slice(start + 1).join('\n').trim()
}

export function loadSabotageSkills(rootDir: string): SabotageSkill[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SabotageSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(rootDir, entry.name)
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'))
    } catch {
      continue // not a skill folder
    }
    let md = ''
    try {
      md = fs.readFileSync(path.join(dir, 'skill.md'), 'utf-8')
    } catch {
      md = ''
    }
    skills.push({
      name: typeof meta.name === 'string' ? meta.name : entry.name,
      title: typeof meta.title === 'string' ? meta.title : String(meta.name ?? entry.name),
      level: normalizeLevel(meta.level),
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      appliesTo: Array.isArray(meta.appliesTo) ? (meta.appliesTo as string[]) : [],
      description: section(md, 'Description'),
      recipe: fromHeadingToEnd(md, 'Sabotage instructions'),
      dir,
    })
  }

  skills.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
  return skills
}

// The bundled sabotage skills ship with the webserver. dist mirrors src, so
// this module sits at `.../apps/web-server/src/features/benchmark/logic/runtime/`
// and the prompts at `.../apps/web-server/prompts/` — five levels up + `prompts`
// resolves in both `dist/` and source (same relative shape).
export const SABOTAGE_SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'prompts', 'sabotage-skills')

/** Load the sabotage skills bundled with the webserver. */
export function loadBundledSabotageSkills(): SabotageSkill[] {
  return loadSabotageSkills(SABOTAGE_SKILLS_DIR)
}

export function sabotageSkillsForFeature(
  skills: SabotageSkill[],
  feature: string,
): SabotageSkill[] {
  return skills.filter(
    (s) => s.appliesTo.length === 0 || s.appliesTo.includes('*') || s.appliesTo.includes(feature),
  )
}
