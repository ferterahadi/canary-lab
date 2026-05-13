import { describe, expect, it } from 'vitest'
import { evaluationOutputPanel } from './EvaluationExportTaskToast'

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
})
