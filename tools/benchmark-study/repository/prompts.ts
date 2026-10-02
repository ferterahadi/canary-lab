import { diagnosisPolicy } from '../../../shared/diagnosis-policy'
import { renderDiagnosisPolicy } from '../../../apps/web-server/src/features/runs/logic/runtime/heal-diagnosis-policy'
import { loadPromptTemplate, promptPath, renderPromptTemplate, renderPrompt } from '../../../apps/web-server/src/shared/prompts'
import { sha } from '../files'
import type { StudyManifest, Attempt } from '../types'
import path from 'node:path'
import { readRepositoryFailureContext } from './failure-context'

export function repositoryPromptDigests(manifest: Pick<StudyManifest, 'design' | 'repository'>): Record<string, string> {
  const template = loadPromptTemplate(promptPath('benchmark-study/repository-repair.md'))
  const arms = manifest.design?.variants ?? [{ id: 'canary', diagnosisPolicy: 'per-failure' as const }, { id: 'plain', diagnosisPolicy: 'parent-only' as const }]
  const child = loadPromptTemplate(promptPath('benchmark-study/repository-child.md'))
  const delegation = loadPromptTemplate(promptPath(manifest.repository?.childAudit?.backend === 'local-v1'
    ? 'benchmark-study/repository-codex-v1-delegation.md' : 'benchmark-study/repository-codex-v2-delegation.md'))
  return Object.fromEntries(arms.map((arm) => [arm.id, sha(JSON.stringify({ child, parent: renderPromptTemplate(template,
    { diagnosisPolicyGuidance: renderDiagnosisPolicy(diagnosisPolicy(arm.diagnosisPolicy)), codexDelegationGuidance: delegation }) }))]))
}

export function renderRepositoryRepairPrompt(manifest: StudyManifest, attempt: Attempt): string {
  const context = path.join(manifest.root, 'frozen/diagnosis', attempt.agent, attempt.scenario)
  const failures = readRepositoryFailureContext(context)
  const policy = attempt.variant?.diagnosisPolicy ?? (attempt.workflow === 'plain' ? 'parent-only' : 'per-failure')
  const pin = manifest.pins[attempt.agent]
  const codexDelegationGuidance = renderPrompt(manifest.repository?.childAudit?.backend === 'local-v1'
    ? 'benchmark-study/repository-codex-v1-delegation.md' : 'benchmark-study/repository-codex-v2-delegation.md',
  { childModel: pin.model, childEffort: pin.effort })
  return renderPrompt('benchmark-study/repository-repair.md', { diagnostics: JSON.stringify(failures, null, 2),
    diagnosisPolicyGuidance: renderDiagnosisPolicy(diagnosisPolicy(policy)), maxChecks: String(manifest.repository!.maxChecks),
    codexDelegationGuidance })
}
