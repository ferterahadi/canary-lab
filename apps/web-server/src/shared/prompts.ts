import fs from 'fs'
import path from 'path'

// Every LLM prompt canary spawns lives in `apps/web-server/prompts/` as a flat
// `.md` template with `{{placeholder}}` slots (optionally paired with a
// `.schema.json` for structured output). This module is the one place that
// resolves that directory and does the load + substitute — see
// `.claude/skills/cl_manage-prompts` for the convention new prompts follow.
export const PROMPTS_DIR = path.resolve(__dirname, '../../prompts')

export function promptPath(name: string): string {
  return path.join(PROMPTS_DIR, name)
}

export function loadPromptTemplate(templatePath: string): string {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found at ${templatePath}. Rebuild or reinstall canary-lab.`)
  }
  return fs.readFileSync(templatePath, 'utf-8').trim()
}

// Substitute `{{key}}` placeholders. A line holding nothing but one known
// placeholder is dropped entirely when that placeholder resolves to '' — lets
// a template carry optional bullets/sections without leaving a blank line
// behind. A placeholder absent from `vars` is left intact (line included) so
// an out-of-sync template degrades visibly instead of silently losing text.
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  const placeholderOnlyLine = /^[ \t]*\{\{(\w+)\}\}[ \t]*$/
  const kept: string[] = []
  for (const line of template.split('\n')) {
    const solo = line.match(placeholderOnlyLine)
    if (solo && Object.prototype.hasOwnProperty.call(vars, solo[1]) && vars[solo[1]].length === 0) continue
    kept.push(
      line.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
      ),
    )
  }
  return kept.join('\n')
}

export function renderPrompt(name: string, vars: Record<string, string>): string {
  return renderPromptTemplate(loadPromptTemplate(promptPath(name)), vars)
}
