import type { StudyManifest } from './types'
import { blockIntervals } from './design'
import { totalTokens } from './usage'

export function summarizeVariants(manifest: StudyManifest) {
  const variants = manifest.design?.variants
  if (!variants) return []
  const arms = variants.map((variant) => variant.id)
  const control = variants.find((variant) => variant.diagnosisPolicy === 'per-failure')!.id
  return (['codex', 'claude'] as const).flatMap((agent) => (['single-service', 'cross-service'] as const).flatMap((scenario) => {
    const planned = manifest.attempts.filter((attempt) => attempt.agent === agent && attempt.scenario === scenario)
    if (!planned.length) return []
    const results = manifest.results.filter((row) => row.agent === agent && row.scenario === scenario)
    const blocks = [...new Set(planned.map((attempt) => attempt.repetition))].map((repetition) => results.filter((row) => row.repetition === repetition))
    const successful = blocks.filter((block) => arms.every((arm) => block.some((row) => row.variant?.id === arm && row.outcome === 'success')))
    const metrics = (['repairMs', 'independentVerdictMs', 'tokens'] as const).map((metric) => {
      const values = successful.map((block) => Object.fromEntries(block.map((row) => [row.variant!.id,
        metric === 'tokens' ? totalTokens(agent, row.usage) ?? NaN : metric === 'independentVerdictMs' ? row.timing?.independentVerdictMs ?? NaN : row.repairMs ?? NaN])))
      return { metric, comparisons: blockIntervals(values, control, arms, manifest.design!.seed) }
    })
    return [{ agent, scenario, plannedBlocks: blocks.length, successfulBlocks: successful.length, metrics,
      arms: arms.map((arm) => {
        const rows = results.filter((row) => row.variant?.id === arm)
        const tokens = rows.map((row) => totalTokens(agent, row.usage))
        return { arm, recorded: rows.length, successful: rows.filter((row) => row.outcome === 'success').length,
          tokens: rows.length && tokens.every((n) => n !== null) ? tokens.reduce<number>((n, value) => n + value!, 0) : null,
          adherence: rows.map((row) => ({ attempt: row.id, ...row.adherence, status: row.adherence?.status ?? 'unknown' })) }
      }) }]
  }))
}

export function variantOverview(manifest: StudyManifest): string {
  const summary = summarizeVariants(manifest)
  if (!summary.length) return ''
  return '\n\n## Assigned variants (all outcomes retained)\n\n| Agent | Scenario | Variant | Verified / recorded | Total tokens |\n| --- | --- | --- | --- | ---: |\n' +
    summary.flatMap((group) => group.arms.map((arm) => `| ${group.agent} | ${group.scenario} | ${arm.arm} | ${arm.successful}/${arm.recorded} | ${arm.tokens ?? 'unknown'} |`)).join('\n') +
    '\n\n## Complete-block uncertainty\n\n' + summary.flatMap((group) => group.metrics.flatMap((metric) => metric.comparisons.map((comparison) =>
      `- ${group.agent} / ${group.scenario} / ${metric.metric}: ${comparison.arm} versus ${comparison.control}; ${comparison.blocks}/${group.plannedBlocks} complete successful blocks; reduction ${comparison.reductionPercent?.toFixed(1) ?? 'unknown'}%; 95% block bootstrap ${comparison.bootstrap95?.map((n) => n.toFixed(1)).join(' to ') ?? 'unknown (fewer than five complete blocks)'}.`))).join('\n') +
    '\n\nIntervals resample entire complete blocks, using the same draws across arms within each metric. Failures stay in assigned-arm totals; successful-block estimates exclude them. Semantic policy adherence requires transcript review and remains unknown until reviewed. A child count cannot certify correct grouping or justified escalation.\n'
}
