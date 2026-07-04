import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'

const PORTIFY_TEMPLATE_PATH = promptPath('portify.md')
const PORTIFY_RETRY_TEMPLATE_PATH = promptPath('portify-retry.md')
const PORTIFY_FEEDBACK_TEMPLATE_PATH = promptPath('portify-feedback.md')

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

function render(templatePath: string, vars: Record<string, string>): string {
  return renderPromptTemplate(loadPromptTemplate(templatePath), vars)
}

export function buildPortifyPrompt(
  feature: FeatureConfig,
  targets: RepoEditTarget[],
  /** Prepended when a sibling feature's port patch was pre-applied to the worktree. */
  seededNote?: string,
): string {
  const body = render(PORTIFY_TEMPLATE_PATH, {
    featureName: feature.name,
    reposSummary: reposSummary(feature, targets),
    featureConfigPath: featureConfigPath(feature),
  })
  return seededNote ? `${seededNote}\n\n${body}` : body
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
