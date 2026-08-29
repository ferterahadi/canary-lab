// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { SettingsModal } from './SettingsModal'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getProjectConfig: vi.fn(),
    putProjectConfig: vi.fn(),
    changeProjectPort: vi.fn(),
    listWorkspaceDirs: vi.fn(),
    getGhStatus: vi.fn(),
    getAgentProbe: vi.fn(),
  }
})

function setInputValue(input: HTMLInputElement, value: string): void {
  // React tracks the controlled value via a property descriptor, so a plain
  // `input.value = …` won't fire onChange. Use the prototype setter.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getProjectConfig).mockReset()
  vi.mocked(api.putProjectConfig).mockReset()
  vi.mocked(api.changeProjectPort).mockReset()
  vi.mocked(api.getGhStatus).mockReset().mockResolvedValue({ installed: true, authenticated: true, account: 'ferterahadi-acme', host: 'github.com' })
  vi.mocked(api.listWorkspaceDirs).mockReset().mockResolvedValue({
    root: '/tmp/wiki',
    at: '',
    absolute: '/tmp/wiki',
    parent: '/tmp',
    dirs: [],
  })
  vi.mocked(api.getAgentProbe).mockReset().mockResolvedValue({
    probedAt: 'now',
    claude: { agent: 'claude', state: 'ok', binaryPath: '/bin/claude', version: '1', remedy: null },
    codex: { agent: 'codex', state: 'ok', binaryPath: '/bin/codex', version: '1', remedy: null },
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('SettingsModal', () => {
  it('R80: the GitHub section shows the connected account and refreshes on demand', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})
    const gh = container.querySelector('[data-testid="settings-github"]')
    expect(gh?.textContent).toContain('Connected as ferterahadi-acme')
    // Auth can change outside the app — the Refresh button re-detects.
    vi.mocked(api.getGhStatus).mockResolvedValue({ installed: true, authenticated: false })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="settings-github-refresh"]')?.click() })
    await act(async () => {})
    expect(container.querySelector('[data-testid="settings-github"]')?.textContent).toContain('gh auth login')
  })

  it('renders the current wiki path and saves a new one picked via the folder picker', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/Users/dev/Documents/wiki/wiki',
    })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/tmp/wiki',
    })

    await act(async () => {
      root.render(<SettingsModal onClose={onClose} />)
    })
    await act(async () => {})

    const pickerButton = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('/Users/dev/Documents/wiki/wiki'))
    expect(pickerButton).toBeTruthy()

    await act(async () => {
      pickerButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const confirm = [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Use wiki folder')
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.putProjectConfig).toHaveBeenCalledWith({
      healAgent: 'claude',
      editor: 'auto',
      personalWikiPath: '/tmp/wiki',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the current port and redirects to the new origin after a change', async () => {
    const onClose = vi.fn()
    const onRedirect = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null, port: 8000,
    })
    vi.mocked(api.changeProjectPort).mockResolvedValue({
      restarting: true, port: 9000, newOrigin: 'http://localhost:9000',
    })

    await act(async () => { root.render(<SettingsModal onClose={onClose} onRedirect={onRedirect} />) })
    await act(async () => {})

    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('8000')

    await act(async () => { setInputValue(input, '9000') })
    const change = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Change port')
    await act(async () => { change!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(api.changeProjectPort).toHaveBeenCalledWith(9000, false)
    expect(onRedirect).toHaveBeenCalledWith('http://localhost:9000', expect.any(Function))
  })

  it('defaults the port field to 7421 when none is configured', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null,
    })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})
    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    expect(input.value).toBe('7421')
  })

  it('requires confirmation when runs are active, then retries with confirm', async () => {
    const onRedirect = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null, port: 8000,
    })
    vi.mocked(api.changeProjectPort)
      .mockResolvedValueOnce({ needsConfirm: true, activeRuns: 2, restarting: false })
      .mockResolvedValueOnce({ restarting: true, port: 9000, newOrigin: 'http://localhost:9000' })

    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} onRedirect={onRedirect} />) })
    await act(async () => {})

    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    await act(async () => { setInputValue(input, '9000') })
    const change = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Change port')
    await act(async () => { change!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(container.textContent).toContain('2')
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restart anyway')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(api.changeProjectPort).toHaveBeenNthCalledWith(1, 9000, false)
    expect(api.changeProjectPort).toHaveBeenNthCalledWith(2, 9000, true)
    expect(onRedirect).toHaveBeenCalledWith('http://localhost:9000', expect.any(Function))
  })

  it('summarizes each agent’s stage plan; the matrix save refreshes the line without a settings save', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude',
      editor: 'auto',
      personalWikiPath: null,
      agentModels: { claude: { heal: { model: 'opus', effort: 'high' } }, codex: {} },
    })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})

    expect(container.querySelector('[data-testid="model-summary-claude"]')?.textContent)
      .toContain('Auto-repair opus · high')
    expect(container.querySelector('[data-testid="model-summary-codex"]')?.textContent)
      .toBe('All stages agent default')

    // Configure models → the matrix stacks over settings for that agent.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="configure-models-claude"]')!.click() })
    await act(async () => {})
    const matrix = document.querySelector('[data-testid="model-matrix-dialog"]')
    expect(matrix).toBeTruthy()

    // The matrix saves ONLY the agentModels block; onSaved refreshes the
    // summary line while the settings Save button stays clean (not dirty).
    const savedModels = { claude: { heal: { model: 'sonnet', effort: 'high' } }, codex: {} }
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null, agentModels: savedModels,
    })
    const effort = document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair model"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(effort, 'sonnet')
    effort.dispatchEvent(new Event('change', { bubbles: true }))
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!.click() })
    await act(async () => {})

    expect(api.putProjectConfig).toHaveBeenCalledWith({ agentModels: savedModels })
    expect(document.querySelector('[data-testid="model-matrix-dialog"]')).toBeNull()
    expect(container.querySelector('[data-testid="model-summary-claude"]')?.textContent)
      .toContain('Auto-repair sonnet')
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('the At-launch radios flip askModelsOnLaunch and persist it on Save', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null, askModelsOnLaunch: true,
    })
    await act(async () => { root.render(<SettingsModal onClose={onClose} />) })
    await act(async () => {})

    // Absent flag reads as "use defaults silently" (false).
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-ask-models-false"]')!.checked).toBe(true)
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    await act(async () => { container.querySelector<HTMLInputElement>('[data-testid="settings-ask-models-true"]')!.click() })
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })

    expect(api.putProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ askModelsOnLaunch: true }))
    expect(onClose).toHaveBeenCalled()
  })
})
