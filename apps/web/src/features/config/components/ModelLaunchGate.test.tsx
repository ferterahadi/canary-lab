// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { ModelLaunchGate } from './ModelLaunchGate'

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
  it('previews the resolved defaults per scoped stage on the defaults card', async () => {
    await mount()
    const defaults = byTestId('gate-use-defaults')
    expect(defaults.textContent).toContain('Auto-repair')
    expect(defaults.textContent).toContain('opus · high')
    expect(defaults.textContent).toContain('Commit message')
    expect(defaults.textContent).toContain('haiku')
    // Only the launch's stages appear — no flight-only rows on a run gate.
    expect(defaults.textContent).not.toContain('Repo scan')
  })

  it('an unpinned stage previews as "agent default"', async () => {
    await mount({ config: { claude: {}, codex: {} } })
    expect(byTestId('gate-use-defaults').textContent).toContain('agent default')
  })

  it('confirm on the defaults card hands back null — the server resolves config itself', async () => {
    const props = await mount()
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith(null)
    expect(api.putProjectConfig).not.toHaveBeenCalled()
  })

  it('customize reveals the grid seeded from resolved defaults; edits ride the confirm', async () => {
    const props = await mount()
    expect(document.querySelector('[data-testid="model-row-heal"]')).toBeNull()
    await act(async () => { byTestId<HTMLButtonElement>('gate-customize').click() })
    const effort = document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair reasoning effort"]')!
    expect(effort.value).toBe('high')
    setSelect(effort, 'max')
    await act(async () => { byTestId<HTMLButtonElement>('gate-confirm').click() })
    expect(props.onConfirm).toHaveBeenCalledWith({
      heal: { model: 'opus', effort: 'max' },
      commit: { model: 'haiku', effort: null },
    })
  })

  it('loads the installed Codex model catalog only when Customize is opened', async () => {
    await mount({ agent: 'codex', stages: ['heal'], config: { claude: {}, codex: {} } })
    expect(api.getAgentProbe).not.toHaveBeenCalled()
    await act(async () => { byTestId<HTMLButtonElement>('gate-customize').click() })
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
    expect(dialog.textContent).toContain('Final once started')
    expect(byTestId('gate-confirm').textContent).toBe('Start flight')
  })
})
