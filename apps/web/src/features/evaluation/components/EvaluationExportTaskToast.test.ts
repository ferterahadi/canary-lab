import { describe, expect, it } from 'vitest'
import { evaluationOutputPanel, evaluationTaskMeta, evaluationTaskRunLabel } from './EvaluationExportTaskToast'

describe('evaluation export task labels', () => {
  it('uses the run feature as the primary task label', () => {
    expect(evaluationTaskRunLabel({ feature: 'shop_nginx_support', runId: '2026-05-28T0443-jjcx' })).toBe('shop_nginx_support')
  })

  it('falls back to the run id when an older task has no feature name', () => {
    expect(evaluationTaskRunLabel({ feature: '   ', runId: '2026-05-28T0443-jjcx' })).toBe('2026-05-28T0443-jjcx')
  })

  it('keeps export mode and status in secondary task metadata', () => {
    expect(evaluationTaskMeta({ mode: 'localized', status: 'completed', runId: '2026-05-28T0443-jjcx' })).toBe(
      'Localized output · completed · 2026-05-28T0443-jjcx',
    )
  })
})

describe('evaluationOutputPanel', () => {
  it('shows raw export lifecycle logs without extra LLM guidance text', () => {
    const panel = evaluationOutputPanel(
      { mode: 'raw' },
      '[evaluation] preparing raw output export\n[evaluation] task completed\n',
    )

    expect(panel.heading).toBe('Export progress')
    expect(panel.text).toContain('[evaluation] preparing raw output export')
    expect(panel.text).not.toContain('Use Localized output')
  })

  it('labels localized export logs as agent output', () => {
    const panel = evaluationOutputPanel(
      { mode: 'localized' },
      '[agent:codex] starting localized rewrite\nthinking...\n',
    )

    expect(panel.heading).toBe('Agent output')
    expect(panel.text).toContain('[agent:codex] starting localized rewrite')
  })

  it('summarizes external-client exports without showing agent output', () => {
    const panel = evaluationOutputPanel(
      {
        mode: 'localized',
        producer: 'external',
        clientKind: 'codex',
        conversationName: 'Export this into evaluation',
      },
      '[agent:codex] internal transcript that should not render\n',
    )

    expect(panel.heading).toBe('Export progress')
    expect(panel.text).toContain('Generated using external client')
    expect(panel.text).toContain('codex')
    expect(panel.text).toContain('Export this into evaluation')
    expect(panel.text).not.toContain('internal transcript')
  })

  it('shows cached localized output logs without extra guidance text', () => {
    const panel = evaluationOutputPanel(
      { mode: 'localized' },
      '[evaluation] using cached localized wording\n[evaluation] export archive ready\n',
    )

    expect(panel.heading).toBe('Agent output')
    expect(panel.text).toContain('[evaluation] using cached localized wording')
    expect(panel.text).not.toContain('no agent run was needed')
  })

  it('explains when a localized agent has started but has not emitted output yet', () => {
    const panel = evaluationOutputPanel(
      { mode: 'localized' },
      '[evaluation] generating localized wording\n[agent:claude] starting localized rewrite (model: haiku)\n',
    )

    expect(panel.heading).toBe('Agent output')
    expect(panel.text).toContain('The agent process has started with haiku')
    expect(panel.text).toContain('[agent:claude] starting localized rewrite (model: haiku)')
  })

  it('normalizes raw agent JSON output into a fenced json block', () => {
    const panel = evaluationOutputPanel(
      { mode: 'localized' },
      [
        '[evaluation] generating localized wording',
        '[agent:codex] starting localized rewrite (model: agent default)',
        '{"slots":[{"id":"summary","text":"Readable summary"}]}',
        '[agent:codex] localized rewrite completed',
      ].join('\n'),
    )

    expect(panel.text).toContain('```json')
    expect(panel.text).toContain('"slots": [')
    expect(panel.text).toContain('[agent:codex] localized rewrite completed')
  })

  it('keeps already fenced claude json output unchanged', () => {
    const log = [
      '[agent:claude] starting localized rewrite (model: agent default)',
      '```json',
      '{"slots":[]}',
      '```',
    ].join('\n')

    const panel = evaluationOutputPanel({ mode: 'localized' }, log)

    expect(panel.text.match(/```json/g)).toHaveLength(1)
    expect(panel.text).toContain('{"slots":[]}')
  })
})
