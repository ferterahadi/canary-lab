import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoBranchSnapshot, ServiceManifestEntry } from '@/shared/api/types'
import { UNPRESERVED_CAUSE } from '@/shared/ui/BootEvidence'
import { openEditor } from '@/shared/api/client'
import { bootEvidencePreview, ServiceCard } from './RunServicePanels'

vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/api/client')>(),
  openEditor: vi.fn(async () => ({})),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(() => {
  root.unmount()
  container.remove()
})

const service: ServiceManifestEntry = {
  name: 'merchant-pass',
  safeName: 'merchant-pass',
  command: './gradlew :merchant-service:bootRun',
  cwd: '/repos/merchant-pass',
  logPath: '/logs/runs/abc/svc-merchant-pass.log',
  healthUrl: 'http://localhost:51774/actuator/health',
  status: 'stopped',
} as ServiceManifestEntry

const branch: RepoBranchSnapshot = {
  name: 'merchant-pass',
  branch: 'release/2.9.0',
  dirty: false,
  detached: false,
} as RepoBranchSnapshot

function render(node: React.ReactNode): void {
  act(() => { root.render(<ul>{node}</ul>) })
}

function labels(): string[] {
  return [...container.querySelectorAll('.cl-rubric')].map((n) => n.textContent ?? '')
}

describe('ServiceCard', () => {
  it('always shows the same five facts, in order', () => {
    render(<ServiceCard service={service} branch={branch} />)

    expect(container.textContent).toContain('merchant-pass')
    expect(labels()).toEqual(['cmd', 'cwd', 'ref', 'url'])
    expect(container.textContent).toContain('./gradlew :merchant-service:bootRun')
    expect(container.textContent).toContain('/repos/merchant-pass')
    expect(container.textContent).toContain('release/2.9.0')
    expect(container.querySelector('a[href="http://localhost:51774/actuator/health"]')).toBeTruthy()
  })

  it('titles each card with the service when one repo hosts several', () => {
    // The demo's shape: catalog, inventory and checkout all out of `storefront`.
    // Every card used to be titled "storefront", so the stack was unreadable.
    const demoServices = ['catalog-service', 'inventory-service', 'checkout-service'].map((name) => ({
      ...service,
      repoName: 'storefront',
      name,
      safeName: name,
      command: `npm run dev:${name.split('-')[0]}`,
    })) as ServiceManifestEntry[]

    render(<>{demoServices.map((s) => (
      <ServiceCard key={s.safeName} service={s} branch={null} siblings={demoServices.length} />
    ))}</>)

    const titles = [...container.querySelectorAll('li > div > div.truncate')].map((n) => n.textContent)
    expect(titles).toEqual(['catalog-service', 'inventory-service', 'checkout-service'])
    expect(titles).not.toContain('storefront')
  })

  it('keeps the repo name as the title for a lone service in its repo', () => {
    render(<ServiceCard service={{ ...service, repoName: 'merchant-pass' } as ServiceManifestEntry} branch={branch} siblings={1} />)

    const title = container.querySelector('li > div > div.truncate')?.textContent
    expect(title).toBe('merchant-pass')
  })

  it('shows the current structured boot failure on the affected service card', () => {
    render(<ServiceCard
      service={service}
      branch={branch}
      bootFailure={{
        service: 'merchant-pass', safeName: 'merchant-pass', reason: 'process-exited', classification: 'underlying-cause-not-preserved',
        detail: 'Service exited before readiness.', logPath: '/logs/service.log', command: service.command, cwd: service.cwd,
        exitCode: 1, signal: null, excerpt: 'wrapper exited',
        nextAction: 'Update the outer wrapper to log and rethrow the original failure.',
      }}
    />)

    expect(container.textContent).toContain('Service exited before becoming ready.')
    expect(container.textContent).toContain(UNPRESERVED_CAUSE)
    expect(container.textContent).toContain('wrapper exited')
    expect(container.textContent).toContain('Update the outer wrapper')
    expect(container.textContent).not.toContain('process-exit')

    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons.find((button) => button.textContent?.includes('Diagnostics'))!.click())
    expect(container.textContent).toContain('process-exit')
    expect(container.textContent).toContain('underlying-cause-not-preserved')
    expect(container.textContent).toContain('exit 1')
    expect(labels()).toEqual(['cmd', 'cwd', 'ref', 'url', 'Detail', 'Phase', 'Evidence', 'Process', 'Preserved output'])
    act(() => buttons.find((button) => button.textContent === 'Open service log')!.click())
    expect(openEditor).toHaveBeenCalledWith({ file: '/logs/service.log' })
  })

  it('previews the first useful evidence window and keeps the complete excerpt behind Diagnostics', () => {
    const excerpt = [
      'Container database Running',
      'Container rabbitmq Running',
      'Error: Merchant Pass refused the login with HTTP 401',
      'Unauthorized · /api/v1/user-auth/authorize',
      'at bootstrap (/worktree/start.cjs:24:19)',
      'at async main (/worktree/start.cjs:31:2)',
    ].join('\n')
    render(<ServiceCard
      service={service}
      branch={branch}
      bootFailure={{
        service: service.name, safeName: service.safeName, reason: 'process-exited', detail: 'Exited.',
        logPath: '/logs/service.log', excerpt, excerptTruncated: true,
        nextAction: 'Fix the failure shown in the preserved process evidence, then restart the run.',
      }}
    />)

    const failure = container.querySelector('[data-testid="service-boot-failure"]')!
    expect(failure.textContent).toContain('Merchant Pass refused the login')
    expect(failure.textContent).not.toContain('Container database Running')
    expect(failure.textContent).not.toContain('Fix the failure shown')
    act(() => (failure.querySelector('[aria-expanded="false"]') as HTMLButtonElement).click())
    expect(failure.textContent).toContain('Container database Running')
    expect(failure.textContent).toContain('excerpt truncated; open the service log')
    expect(failure.textContent).not.toContain('/logs/service.log')
  })

  it('holds the ref and url rows open with a placeholder when there is nothing to show', () => {
    render(<ServiceCard service={{ ...service, healthUrl: undefined } as ServiceManifestEntry} branch={null} />)

    // Same shape as a fully-populated card — a missing branch is a fact, not a
    // reason for the card to change form.
    expect(labels()).toEqual(['cmd', 'cwd', 'ref', 'url'])
    expect(container.textContent).toContain('—')
  })

  it('starts the title on the card edge, with no status-dot slot indenting it', () => {
    render(<ServiceCard service={service} branch={branch} />)

    const header = container.querySelector('.cl-card')?.firstElementChild
    expect(header?.firstElementChild?.textContent).toBe('merchant-pass')
  })

  it('never shows the log path — the Services tab streams that log live', () => {
    render(<ServiceCard service={service} branch={branch} />)

    expect(container.textContent).not.toContain('svc-merchant-pass.log')
    expect(labels()).not.toContain('log')
  })
})

describe('bootEvidencePreview', () => {
  it('uses the first explicit failure line and falls back to the log tail', () => {
    expect(bootEvidencePreview('up\nError: denied\nline two\nline three\nline four')).toBe('Error: denied\nline two\nline three')
    expect(bootEvidencePreview('one\ntwo\nthree\nfour')).toBe('two\nthree\nfour')
    expect(bootEvidencePreview(undefined)).toBeNull()
  })
})
