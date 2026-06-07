import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../shared/launcher/types'

const PROMPTS_DIR = path.join(__dirname, '../../../prompts')
const PORTIFY_TEMPLATE_PATH = path.join(PROMPTS_DIR, 'portify.md')
const PORTIFY_RETRY_TEMPLATE_PATH = path.join(PROMPTS_DIR, 'portify-retry.md')

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
  const template = fs.readFileSync(templatePath, 'utf-8')
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
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
