// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { AgentProbe } from '@/shared/api/client'
import { MODEL_STAGE_KEYS, recommendedChoice } from '@shared/agent-models'
import { ModelMatrixDialog, StageChoiceGrid } from './ModelMatrixDialog'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getAgentProbe: vi.fn(),
    putProjectConfig: vi.fn(),
  }
})

const OK_PROBE = (agent: 'claude' | 'codex', over: Partial<AgentProbe> = {}): AgentProbe => ({
  agent, state: 'ok', binaryPath: `/usr/local/bin/${agent}`, version: '9.9.9', remedy: null, ...over,
})
const SNAPSHOT = { probedAt: '2026-08-28T00:00:00Z', claude: OK_PROBE('claude'), codex: OK_PROBE('codex') }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getAgentProbe).mockReset().mockResolvedValue(SNAPSHOT)
  vi.mocked(api.putProjectConfig).mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function select(label: string): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  expect(el, label).toBeTruthy()
  return el!
}

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const EMPTY = { claude: {}, codex: {} }

async function mount(over: Partial<Parameters<typeof ModelMatrixDialog>[0]> = {}) {
  const props = { agent: 'claude' as const, agentModels: EMPTY, onClose: vi.fn(), onSaved: vi.fn(), ...over }
  await act(async () => { root.render(<ModelMatrixDialog {...props} />) })
  await act(async () => {})
  return props
}

describe('ModelMatrixDialog', () => {
  it('renders one row per stage with the probe result in the strip', async () => {
    await mount()
    for (const stage of MODEL_STAGE_KEYS) {
      expect(document.querySelector(`[data-testid="model-row-${stage}"]`), stage).toBeTruthy()
    }
    expect(document.querySelector('[data-testid="model-matrix-dialog"]')?.textContent).toContain('claude CLI found — 9.9.9')
  })

  it('saves ONLY the agentModels block, this agent replaced and the other kept', async () => {
    const codexPlans = { heal: { model: null, effort: 'xhigh' } }
    const saved = { healAgent: 'claude' as const, editor: 'auto' as const, personalWikiPath: null, agentModels: { claude: { heal: { model: 'opus', effort: 'high' } }, codex: codexPlans } }
    vi.mocked(api.putProjectConfig).mockResolvedValue(saved)
    const props = await mount({ agentModels: { claude: {}, codex: codexPlans } })

    setSelect(select('Auto-repair model'), 'opus')
    setSelect(select('Auto-repair reasoning effort'), 'high')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!.click() })

    expect(api.putProjectConfig).toHaveBeenCalledWith({
      agentModels: { claude: { heal: { model: 'opus', effort: 'high' } }, codex: codexPlans },
    })
    expect(props.onSaved).toHaveBeenCalledWith(saved)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('Save is disabled until a row deviates from the saved plans', async () => {
    await mount()
    const save = document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!
    expect(save.disabled).toBe(true)
    setSelect(select('Report model'), 'haiku')
    expect(save.disabled).toBe(false)
    // Back to agent default → the row is pruned and the dialog is clean again.
    setSelect(select('Report model'), '')
    expect(save.disabled).toBe(true)
  })

  it('a save failure stays open and says why', async () => {
    vi.mocked(api.putProjectConfig).mockRejectedValue(new Error('disk full'))
    const props = await mount()
    setSelect(select('Report model'), 'haiku')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!.click() })
    expect(document.querySelector('[data-testid="model-matrix-dialog"]')?.textContent).toContain('disk full')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('✦ rec marks a row matching the shipped recommendation; custom gets the amber chip + reset', async () => {
    await mount()
    const rec = recommendedChoice('claude', 'heal')
    setSelect(select('Auto-repair model'), rec.model!)
    setSelect(select('Auto-repair reasoning effort'), rec.effort!)
    expect(document.querySelector('[data-testid="model-row-heal"]')?.textContent).toContain('✦ rec')

    setSelect(select('Auto-repair reasoning effort'), 'low')
    const row = document.querySelector('[data-testid="model-row-heal"]')!
    expect(row.textContent).toContain('custom')
    await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-label="Reset Auto-repair to recommended"]')!.click() })
    expect(document.querySelector('[data-testid="model-row-heal"]')?.textContent).toContain('✦ rec')
  })

  it('Custom id… reveals the free-text input; a typed id round-trips, a blanked one falls back to agent default', async () => {
    await mount()
    setSelect(select('Report model'), '__custom')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Report custom model id"]')!
    expect(input).toBeTruthy()
    setInput(input, 'claude-next-preview')
    expect(select('Report model').value).toBe('__custom')
    setInput(input, '   ')
    // Blank id = agent default: the input disappears with the pin.
    expect(document.querySelector('input[aria-label="Report custom model id"]')).toBeNull()
  })

  it('Reset all to recommended pins every stage to its tier choice', async () => {
    await mount()
    const buttons = [...document.querySelectorAll('button')]
    await act(async () => { buttons.find((b) => b.textContent === 'Reset all to recommended')!.click() })
    expect(select('Auto-repair model').value).toBe(recommendedChoice('claude', 'heal').model)
    expect(select('Commit message model').value).toBe(recommendedChoice('claude', 'commit').model)
    expect(document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!.disabled).toBe(false)
  })

  it('an auth-failed probe warns with the remedy and Retry re-probes fresh — nothing is disabled', async () => {
    vi.mocked(api.getAgentProbe).mockResolvedValue({
      ...SNAPSHOT,
      claude: OK_PROBE('claude', { state: 'auth', version: null, remedy: 'Run `claude login`.' }),
    })
    await mount()
    const warning = document.querySelector('[data-testid="model-matrix-probe-warning"]')!
    expect(warning.textContent).toContain('needs a sign-in')
    expect(warning.textContent).toContain('claude login')

    vi.mocked(api.getAgentProbe).mockResolvedValue(SNAPSHOT)
    await act(async () => { warning.querySelector<HTMLButtonElement>('button')!.click() })
    await act(async () => {})
    expect(api.getAgentProbe).toHaveBeenLastCalledWith(true)
    expect(document.querySelector('[data-testid="model-matrix-probe-warning"]')).toBeNull()
  })

  it('a missing CLI warns but the matrix stays editable', async () => {
    vi.mocked(api.getAgentProbe).mockResolvedValue({
      ...SNAPSHOT,
      claude: OK_PROBE('claude', { state: 'missing', binaryPath: null, version: null, remedy: 'Install the claude CLI.' }),
    })
    await mount()
    expect(document.querySelector('[data-testid="model-matrix-probe-warning"]')?.textContent).toContain("isn't on PATH")
    expect(select('Auto-repair model').disabled).toBe(false)
  })

  it('a failed probe stays quiet ("unavailable") instead of warning', async () => {
    vi.mocked(api.getAgentProbe).mockRejectedValue(new Error('down'))
    await mount()
    expect(document.body.textContent).toContain('CLI check unavailable — settings still apply.')
    expect(document.querySelector('[data-testid="model-matrix-probe-warning"]')).toBeNull()
  })
})

describe('StageChoiceGrid (standalone, as the launch gate embeds it)', () => {
  it('renders only the scoped stages and reports changes through onChange', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<StageChoiceGrid agent="codex" stages={['heal', 'commit']} plans={{}} onChange={onChange} />)
    })
    expect(document.querySelector('[data-testid="model-row-heal"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="model-row-scout"]')).toBeNull()
    // Codex has no curated model list — the dropdown is default + custom only.
    const modelSelect = select('Auto-repair model')
    expect([...modelSelect.options].map((o) => o.value)).toEqual(['', '__custom'])
    setSelect(select('Auto-repair reasoning effort'), 'xhigh')
    expect(onChange).toHaveBeenCalledWith('heal', { model: null, effort: 'xhigh' })
  })
})
