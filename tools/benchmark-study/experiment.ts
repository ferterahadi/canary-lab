import fs from 'node:fs'
import path from 'node:path'
import { diagnosisPolicy } from '../../shared/diagnosis-policy'
import { renderDiagnosisPolicy } from '../../apps/web-server/src/features/runs/logic/runtime/heal-diagnosis-policy'
import { loadPromptTemplate, promptPath } from '../../apps/web-server/src/shared/prompts'
import { readJson, sha } from './files'
import { totalTokens } from './usage'
import type { Agent, StudyManifest, Usage } from './types'
import { repositoryPromptDigests } from './repository/prompts'

export function preflightTokens(manifest: StudyManifest): number | null {
  const preflight = manifest.preparation.nativeRuntime as { evidence: Array<{ agent: Agent; evidence: string }> } | undefined
  if (!preflight) return 0
  let total = 0
  for (const entry of preflight.evidence) {
    const file = path.join(manifest.root, entry.evidence, 'usage.json')
    const tokens = fs.existsSync(file) ? totalTokens(entry.agent, readJson<Usage | null>(file)) : null
    if (tokens === null) return null
    total += tokens
  }
  return total
}

export function policyDigests(manifest: Pick<StudyManifest, 'design' | 'repository'>): Record<string, string> {
  if (manifest.repository) return repositoryPromptDigests(manifest)
  const template = loadPromptTemplate(promptPath('heal-agent.md')).replace('{{playwrightMcpHint}}', '')
  return Object.fromEntries((manifest.design?.variants ?? []).map((variant) => [variant.id,
    sha(template.replace('{{diagnosisPolicyGuidance}}', renderDiagnosisPolicy(diagnosisPolicy(variant.diagnosisPolicy))))]))
}

export function configurationDigest(manifest: StudyManifest): string {
  return sha(JSON.stringify({ design: manifest.design, selection: manifest.selection, attempts: manifest.attempts,
    sourceDigest: manifest.sourceDigest, dependencyDigest: manifest.dependencyDigest, dependencyVersions: manifest.dependencyVersions,
    snapshots: manifest.snapshots, frozenDigest: manifest.frozenDigest, pins: manifest.pins, codexToolArgs: manifest.codexToolArgs,
    budgetMs: manifest.budgetMs, repository: manifest.repository, maxTokens: manifest.experiment?.maxTokens, promptDigests: manifest.experiment?.promptDigests }))
}

export function assertExperiment(manifest: StudyManifest, checkPrompts = false): void {
  if (!manifest.design?.variants && !manifest.repository) {
    if (manifest.experiment) throw new Error('Experiment metadata requires an explicit variant design')
    return
  }
  if (!manifest.experiment || !Number.isSafeInteger(manifest.experiment.maxTokens) || manifest.experiment.maxTokens <= 0 ||
    configurationDigest(manifest) !== manifest.experiment.configurationDigest) throw new Error('Frozen experiment configuration changed or is incomplete; prepare a new study')
  if (checkPrompts && JSON.stringify(policyDigests(manifest)) !== JSON.stringify(manifest.experiment.promptDigests)) throw new Error('Frozen diagnosis prompts changed; prepare a new study')
}
