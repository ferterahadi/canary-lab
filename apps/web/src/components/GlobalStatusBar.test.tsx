// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import { GlobalStatusBar } from './GlobalStatusBar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getMcpHealth: vi.fn(),
  }
})

vi.mock('../state/RunsContext', () => ({
  useRuns: () => ({ connection: 'live' }),
}))

vi.mock('./WizardTaskStatus', () => ({
  WizardTaskStatus: () => null,
}))

vi.mock('./EvaluationExportTaskToast', () => ({
  EvaluationExportTaskStatus: () => null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getMcpHealth).mockImplementation(async (profile = 'repair') => {
    const tools = profile === 'author'
      ? ['list_features', 'write_feature_doc']
      : ['start_run', 'wait_for_heal_task']
    return {
      ok: true,
      server: { name: 'canary-lab' },
      profile,
      clientKind: 'other',
      toolCount: tools.length,
      tools,
      activeSessions: 0,
      projectRoot: '/Users/oddle/Documents/canary-lab-workspace',
    }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe('GlobalStatusBar', () => {
  it('replaces the Playwright chip with a collapsed MCP indicator menu', async () => {
    await act(async () => {
      root.render(<GlobalStatusBar activeRunDetail={null} />)
    })

    expect(container.textContent).not.toContain('Playwright')
    expect(container.textContent).toContain('MCP')
    expect(container.textContent).toContain('ready')
    expect(container.textContent).not.toContain('12 tools')
    expect(container.textContent).not.toContain('Check health')
    expect(container.textContent).not.toContain('Test MCP')
    expect(api.getMcpHealth).toHaveBeenCalledWith('repair')

    const indicator = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'MCP connection details')
    expect(indicator).toBeTruthy()

    await act(async () => {
      indicator?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menu = document.body.querySelector('[data-mcp-health-menu]')
    expect(menu?.textContent).not.toContain('MCP repair profile')
    expect(menu?.textContent).toContain('MCP endpoint')
    expect(menu?.textContent).toContain('Ready for external repair agents')
    expect(menu?.textContent).toContain('Workspace')
    expect(menu?.textContent).toContain('canary-lab-workspace')
    expect(menu?.textContent).toContain('/Users/oddle/Documents/canary-lab-workspace')
    expect(menu?.textContent).toContain('Tool set')
    expect(menu?.textContent).toContain('Repair')
    expect(menu?.textContent).toContain('Profiles')
    expect(menu?.textContent).toContain('Author')
    expect(menu?.textContent).toContain('Full')
    expect(menu?.textContent).toContain('Active sessions')
    expect(menu?.textContent).toContain('0')
    expect(menu?.textContent).toContain('MCP URL')
    expect(menu?.textContent).toContain('/mcp')
    expect(menu?.textContent).toContain('Health: /mcp/health')
    expect(menu?.textContent).toContain('2 tools')
    expect(menu?.textContent).toContain('start_run')
    expect(menu?.textContent).toContain('wait_for_heal_task')
    expect(menu?.textContent).toContain('Health OK at')
    expect(menu?.textContent).not.toContain('Check health')
    expect(menu?.textContent).not.toContain('Test MCP')

    const testButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Check health')
    expect(testButton).toBeFalsy()

    const authorButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Author'))
    expect(authorButton).toBeTruthy()

    await act(async () => {
      authorButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(api.getMcpHealth).toHaveBeenLastCalledWith('author')
    expect(document.body.querySelector('[data-mcp-health-menu]')?.textContent).toContain('write_feature_doc')
  })
})
