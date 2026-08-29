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

function hover(element: Element, over: boolean): void {
  act(() => {
    element.dispatchEvent(new MouseEvent(over ? 'mouseover' : 'mouseout', { bubbles: true }))
  })
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
  it('keeps the visible settings copy short and puts secondary explanations behind help icons', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null,
    })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})

    expect(container.textContent).toContain('Used by the UI and MCP server. Default: 7421.')
    expect(container.textContent).not.toContain('Runs with the Claude CLI.')
    expect(container.textContent).not.toContain('Runs with the Codex CLI.')
    // The launch gate is ONE switch, so the description carries both states
    // rather than a second radio row restating "off".
    expect(container.textContent).toContain('Ask before launch')
    expect(container.textContent).toContain('Unchecked, launches start with your saved models.')
    expect(container.textContent).not.toContain('Work started by an external agent')
    // The long wiki explanation moved behind its own help icon.
    expect(container.textContent).toContain('Optional folder of distilled agent notes.')
    expect(container.textContent).not.toContain('Karpathy')

    const portHelp = container.querySelector('[aria-label="Port help"]')!
    hover(portHelp, true)
    expect(document.querySelector('[role="tooltip"]')?.textContent)
      .toContain('Changing the port restarts Canary Lab')
    hover(portHelp, false)

    const agentHelp = container.querySelector('[aria-label="Default agent help"]')!
    hover(agentHelp, true)
    expect(document.querySelector('[role="tooltip"]')?.textContent)
      .toContain('Work started by an external agent uses that agent\'s own model settings.')
    hover(agentHelp, false)

    const launchHelp = container.querySelector('[aria-label="At launch help"]')!
    hover(launchHelp, true)
    expect(document.querySelector('[role="tooltip"]')?.textContent)
      .toContain('Model changes made at launch apply to that launch only.')
    hover(launchHelp, false)

    const wikiHelp = container.querySelector('[aria-label="Personal wiki help"]')!
    hover(wikiHelp, true)
    expect(document.querySelector('[role="tooltip"]')?.textContent)
      .toContain('reads only the notes relevant to the failure it is repairing')
  })

  it('carries the agent choice, its models and the launch gate on one card', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})

    // One section, not two: both agent rows and the launch switch share it.
    const card = container.querySelector('[data-testid="agent-choice-claude"]')!.closest('section')!
    expect(card.querySelector('[data-testid="agent-choice-codex"]')).toBeTruthy()
    expect(card.querySelector('[data-testid="settings-ask-models"]')).toBeTruthy()
    expect(card.textContent).toContain('Agent')

    // The launch gate is a checkbox on the same shape as Onboarding's, not a
    // switch — one row shape for the dialog's standalone on/off settings.
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-ask-models"]')!.type)
      .toBe(container.querySelector<HTMLInputElement>('[data-testid="settings-show-demo"]')!.type)

    // Configure models is an icon; its accessible name still says what it does,
    // and BOTH agents keep their own — a flight can run the non-default agent.
    for (const agent of ['Claude', 'Codex']) {
      const gear = container.querySelector(`[data-testid="configure-models-${agent.toLowerCase()}"]`)!
      expect(gear.getAttribute('aria-label')).toBe(`Configure ${agent} models`)
      expect(gear.textContent).toBe('')
      expect(gear.querySelector('svg')).toBeTruthy()
    }
  })

  it('folds the retired System default choice into Auto-detect', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'system', personalWikiPath: null,
    })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null,
    })
    await act(async () => { root.render(<SettingsModal onClose={onClose} />) })
    await act(async () => {})

    const editorChoices = [...container.querySelectorAll<HTMLInputElement>('input[name="editor"]')]
    expect(editorChoices.map((input) => input.value)).toEqual(['auto', 'cursor', 'vscode'])
    expect(editorChoices[0].checked).toBe(true)
    expect(container.querySelector('input[name="editor"][value="system"]')).toBeNull()

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    expect(api.putProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ editor: 'auto' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('R80: the GitHub section shows the connected account and refreshes on demand', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})
    const gh = container.querySelector('[data-testid="settings-github"]')
    expect(gh?.textContent).toContain('Connected as ferterahadi-acme')
    expect(container.textContent).toContain('Open a draft PR when a repair succeeds')
    expect(container.textContent).toContain('Creates one draft PR per suite and keeps it updated with the latest fix.')
    expect(gh?.textContent).toContain('Signed in through GitHub CLI.')
    expect(container.textContent).not.toContain('heals green')
    // Auth can change outside the app — the re-check icon re-detects.
    const recheck = container.querySelector('[data-testid="settings-github-refresh"]')!
    expect(recheck.textContent).toBe('')
    expect(recheck.getAttribute('aria-label')).toBe('Re-check GitHub sign-in')
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

  it('keeps configured stage plans inline and hides empty-plan summaries', async () => {
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
    expect(container.querySelector('[data-testid="model-summary-codex"]')).toBeNull()
    expect(container.textContent).not.toContain('All stages agent default')

    const claudeRow = container.querySelector('[data-testid="agent-choice-claude"]')!
    expect(claudeRow.querySelector('input[name="healAgent"]')).toBeTruthy()
    expect(claudeRow.querySelector('[data-testid="configure-models-claude"]')).toBeTruthy()

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

  it('the At-launch checkbox flips askModelsOnLaunch and persists it on Save', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'claude', editor: 'auto', personalWikiPath: null, askModelsOnLaunch: true,
    })
    await act(async () => { root.render(<SettingsModal onClose={onClose} />) })
    await act(async () => {})

    // Absent flag reads as "use defaults silently" (unchecked).
    const gate = container.querySelector<HTMLInputElement>('[data-testid="settings-ask-models"]')!
    expect(gate.type).toBe('checkbox')
    expect(gate.checked).toBe(false)
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    await act(async () => { gate.click() })
    expect(gate.checked).toBe(true)
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })

    expect(api.putProjectConfig).toHaveBeenCalledWith(expect.objectContaining({ askModelsOnLaunch: true }))
    expect(onClose).toHaveBeenCalled()
  })
})
