// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { defaultsByChoice, ModelLaunchGate, savedModelsSummary } from './ModelLaunchGate'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getAgentProbe: vi.fn(),
    putProjectConfig: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The gate defers this cached read until Customize is opened.
  vi.mocked(api.getAgentProbe).mockReset().mockResolvedValue({
    probedAt: 'now',
    claude: { agent: 'claude', state: 'ok', binaryPath: '/bin/claude', version: '1', models: [], remedy: null },
    codex: {
      agent: 'codex', state: 'ok', binaryPath: '/bin/codex', version: '1', remedy: null,
      models: [
        { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      ],
    },
  })
  vi.mocked(api.putProjectConfig).mockReset().mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const CONFIG = {
  claude: { heal: { model: 'opus', effort: 'high' }, commit: { model: 'haiku', effort: null } },
  codex: {},
}

async function mount(over: Partial<Parameters<typeof ModelLaunchGate>[0]> = {}) {
  const props = {
    launchNoun: 'run',
    agent: 'claude' as const,
    stages: ['heal', 'commit'] as const,
    config: CONFIG,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    confirmLabel: 'Start run',
    ...over,
  }
  await act(async () => { root.render(<ModelLaunchGate {...props} />) })
  return props
}

function byTestId<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  expect(el, id).toBeTruthy()
  return el!
}

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ModelLaunchGate', () => {
  it('a short plan names its steps in the collapsed confirmation', async () => {
    await mount()
    const summary = byTestId('gate-saved-summary')
    expect(summary.textContent).toContain('Auto-repair')
    expect(summary.textContent).toContain('opus · high')
    expect(summary.textContent).toContain('Commit message')
    expect(summary.textContent).toContain('haiku')
    // Only the launch's stages appear — no flight-only rows on a run gate.
    expect(summary.textContent).not.toContain('Repo scan')
    // The editor is behind Change — the confirmation carries no controls.
    expect(document.querySelector('[data-testid="model-row-heal"]')).toBeNull()
  })

  it('a long plan summarizes by model instead of listing steps', async () => {
    const config = {
      claude: {
        scout: { model: 'sonnet', effort: 'high' },
        docs: { model: 'sonnet', effort: 'medium' },
        prd: { model: 'opus', effort: 'high' },
        gen: { model: 'opus', effort: 'max' },
      },
      codex: {},
    }
    await mount({ stages: ['scout', 'docs', 'prd', 'gen'] as const, config })
    const summary = byTestId('gate-saved-summary')
    expect(summary.textContent).toBe('sonnet on 2 steps · opus on 2 steps')
    // No step name and no effort at this altitude — both live behind Change.
    expect(summary.textContent).not.toContain('Repo scan')
    expect(summary.textContent).not.toContain('max')
    // A stage on the agent default is named as such, and one step stays singular.
    expect(savedModelsSummary('claude', { claude: { gen: { model: 'opus', effort: null } }, codex: {} }, ['gen', 'heal']))
      .toBe('opus on 1 step · agent default on 1 step')
  })

  it('groups steps that share a choice onto one preview row', async () => {
    await mount({
      stages: ['gen', 'heal', 'commit'] as const,
      config: {
        claude: {
          gen: { model: 'opus', effort: 'max' },
          heal: { model: 'opus', effort: 'max' },
          commit: { model: 'sonnet', effort: 'high' },
        },
        codex: {},
      },
    })
    expect(defaultsByChoice('claude', {
      claude: {
        scout: { model: 'sonnet', effort: 'high' },
        gen: { model: 'opus', effort: 'max' },
        heal: { model: 'opus', effort: 'max' },
        commit: { model: 'sonnet', effort: 'high' },
      },
      codex: {},
    }, ['scout', 'gen', 'heal', 'commit'])).toEqual([
      { choice: 'sonnet · high', steps: 'Repo scan, Commit message' },
      { choice: 'opus · max', steps: 'Test authoring, Auto-repair' },
    ])
    // Three steps, two rows — and the shared knobs are printed once, not twice.
    const summary = byTestId('gate-saved-summary')
    expect(summary.textContent).toContain('Test authoring, Auto-repair')
    expect(summary.textContent?.match(/opus · max/g)).toHaveLength(1)
  })

  it('an unpinned stage previews as "agent default"', async () => {
    await mount({ config: { claude: {}, codex: {} } })
    expect(byTestId('gate-saved-summary').textContent).toContain('agent default')
  })

  it('confirm on the defaults card hands back null — the server resolves config itself', async () => {
    const props = await mount()
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith(null)
    expect(api.putProjectConfig).not.toHaveBeenCalled()
  })

  it('Change swaps the confirmation for the grid, seeded from resolved defaults; edits ride the confirm', async () => {
    const props = await mount()
    await act(async () => { byTestId<HTMLButtonElement>('gate-change').click() })
    // The summary is GONE — the dialog is the editor now, not both at once.
    expect(document.querySelector('[data-testid="gate-saved-summary"]')).toBeNull()
    const effort = document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair reasoning effort"]')!
    expect(effort.value).toBe('high')
    setSelect(effort, 'max')
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith({
      heal: { model: 'opus', effort: 'max' },
      commit: { model: 'haiku', effort: null },
    })
  })

  it('Use saved models discards the edits and confirms on the saved plan', async () => {
    const props = await mount()
    await act(async () => { byTestId<HTMLButtonElement>('gate-change').click() })
    setSelect(document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair reasoning effort"]')!, 'max')
    await act(async () => { byTestId<HTMLButtonElement>('gate-use-saved').click() })
    expect(byTestId('gate-saved-summary')).toBeTruthy()
    // Re-opening shows the SAVED value, not the abandoned edit.
    await act(async () => { byTestId<HTMLButtonElement>('gate-change').click() })
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair reasoning effort"]')!.value).toBe('high')
    await act(async () => { byTestId<HTMLButtonElement>('gate-use-saved').click() })
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith(null)
  })

  it('loads the installed Codex model catalog only when Customize is opened', async () => {
    await mount({ agent: 'codex', stages: ['heal'], config: { claude: {}, codex: {} } })
    expect(api.getAgentProbe).not.toHaveBeenCalled()
    await act(async () => { byTestId<HTMLButtonElement>('gate-change').click() })
    await act(async () => {})
    expect(api.getAgentProbe).toHaveBeenCalledWith(false)
    expect([...document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair model"]')!.options]
      .map((option) => [option.value, option.textContent])).toEqual([
      ['', 'Agent default'],
      ['gpt-5.6-sol', 'GPT-5.6-Sol'],
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-5.6-luna', 'GPT-5.6-Luna'],
      ['__custom', 'Custom id…'],
    ])
  })

  it("don't-ask-again writes the master switch off the moment it is toggled — not on confirm", async () => {
    await mount()
    const box = byTestId<HTMLInputElement>('gate-dont-ask-again')
    await act(async () => { box.click() })
    expect(api.putProjectConfig).toHaveBeenCalledWith({ askModelsOnLaunch: false })
  })

  it('a failed don’t-ask-again write is swallowed — the launch flow is unaffected', async () => {
    vi.mocked(api.putProjectConfig).mockRejectedValue(new Error('offline'))
    const props = await mount()
    await act(async () => { byTestId<HTMLInputElement>('gate-dont-ask-again').click() })
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith(null)
  })

  it('Cancel fires onCancel and never onConfirm', async () => {
    const props = await mount()
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(props.onCancel).toHaveBeenCalled()
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('names the launch and locks the plan in copy', async () => {
    await mount({ launchNoun: 'flight', confirmLabel: 'Start flight' })
    const dialog = byTestId('model-launch-gate')
    expect(dialog.textContent).toContain('Models for this flight')
    expect(dialog.textContent).toContain('Locked once started')
    expect(byTestId('gate-confirm').textContent).toBe('Start flight')
  })
})
