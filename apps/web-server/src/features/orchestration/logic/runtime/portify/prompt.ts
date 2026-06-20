import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../../shared/launcher/types'

const PROMPTS_DIR = path.join(__dirname, '../../../../../../prompts')
const PORTIFY_TEMPLATE_PATH = path.join(PROMPTS_DIR, 'portify.md')
const PORTIFY_RETRY_TEMPLATE_PATH = path.join(PROMPTS_DIR, 'portify-retry.md')
const PORTIFY_FEEDBACK_TEMPLATE_PATH = path.join(PROMPTS_DIR, 'portify-feedback.md')

export interface RepoEditTarget {
  name: string
  /** Where to edit this repo's SOURCE — its isolated worktree path. */
  editPath: string
}

function featureConfigPath(feature: FeatureConfig): string {
  return `${feature.featureDir}/feature.config.cjs`
}

function reposSummary(feature: FeatureConfig, targets: RepoEditTarget[]): string {
  return (feature.repos ?? [])
    .map((r) => {
      const target = targets.find((t) => t.name === r.name)
      const cmds = (r.startCommands ?? [])
        .map((c) => (typeof c === 'string' ? c : c.command))
        .map((c) => `      - ${c}`)
        .join('\n')
      return `  • ${r.name} — edit source in: ${target?.editPath ?? r.localPath}\n${cmds || '      (no start commands)'}`
    })
    .join('\n')
}

// Substitute `{{key}}` placeholders. An unknown placeholder (no matching var)
// is left intact so an out-of-sync template degrades visibly rather than
// silently dropping text. Exported for direct unit testing.
export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

function render(templatePath: string, vars: Record<string, string>): string {
  return applyTemplate(fs.readFileSync(templatePath, 'utf-8'), vars)
}

export function buildPortifyPrompt(feature: FeatureConfig, targets: RepoEditTarget[]): string {
  return render(PORTIFY_TEMPLATE_PATH, {
    featureName: feature.name,
    reposSummary: reposSummary(feature, targets),
    featureConfigPath: featureConfigPath(feature),
  })
}

export function buildPortifyRetryPrompt(feature: FeatureConfig, failureDetail: string): string {
  return render(PORTIFY_RETRY_TEMPLATE_PATH, {
    featureConfigPath: featureConfigPath(feature),
    failureDetail,
  })
}

// Prompt for a user-driven revise pass: the agent resumes its session (so it
// keeps full context of its prior edits) and applies the human's feedback,
// then the stack is re-verified.
export function buildPortifyFeedbackPrompt(feature: FeatureConfig, feedback: string): string {
  return render(PORTIFY_FEEDBACK_TEMPLATE_PATH, {
    featureConfigPath: featureConfigPath(feature),
    feedback,
  })
}
