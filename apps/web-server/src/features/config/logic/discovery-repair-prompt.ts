import path from 'path'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import { renderPrompt } from '../../../shared/prompts'

export function buildDiscoveryRepairPrompt(feature: FeatureConfig, diagnostic: string): string {
  return renderPrompt('discovery-repair.md', {
    feature: feature.name,
    projectRoot: path.dirname(path.dirname(feature.featureDir)),
    featureDir: feature.featureDir,
    repos: JSON.stringify((feature.repos ?? []).map(({ name, localPath, branch }) => ({ name, localPath, branch })), null, 2),
    diagnostic,
  })
}
