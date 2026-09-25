import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoBranchSnapshot, ServiceManifestEntry } from '@/shared/api/types'
import { COMPILER_FAILURE_NEXT_ACTION } from '@shared/run-state'
import { UNPRESERVED_CAUSE } from '@/shared/ui/BootEvidence'
import { openRunLog } from '../utils/open-run-log'
import { bootEvidencePreview, ServiceCard } from './RunServicePanels'

vi.mock('../utils/open-run-log', () => ({ openRunLog: vi.fn(async () => {}) }))

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

/** A card with the run-level props every test shares. */
function Card(props: Partial<React.ComponentProps<typeof ServiceCard>>) {
  return <ServiceCard runId="r1" service={service} branch={branch} onOpenBootFailure={() => {}} {...props} />
}

function labels(): string[] {
  return [...container.querySelectorAll('.cl-rubric')].map((n) => n.textContent ?? '')
}

describe('ServiceCard', () => {
  it('always shows the same five facts, in order', () => {
    render(<Card />)

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
      <Card key={s.safeName} service={s} branch={null} siblings={demoServices.length} />
    ))}</>)

    const titles = [...container.querySelectorAll('li > div > div.truncate')].map((n) => n.textContent)
    expect(titles).toEqual(['catalog-service', 'inventory-service', 'checkout-service'])
    expect(titles).not.toContain('storefront')
  })

  it('keeps the repo name as the title for a lone service in its repo', () => {
    render(<Card service={{ ...service, repoName: 'merchant-pass' } as ServiceManifestEntry} siblings={1} />)

    const title = container.querySelector('li > div > div.truncate')?.textContent
    expect(title).toBe('merchant-pass')
  })

  it('shows the current structured boot failure on the affected service card', () => {
    const onOpenBootFailure = vi.fn()
    render(<Card
      bootFailure={{
        service: 'merchant-pass', safeName: 'merchant-pass', reason: 'process-exited', classification: 'underlying-cause-not-preserved',
        detail: 'Service exited before readiness.', logPath: '/logs/service.log', command: service.command, cwd: service.cwd,
        exitCode: 1, signal: null, excerpt: 'wrapper exited',
        nextAction: 'Update the outer wrapper to log and rethrow the original failure.',
      }}
      onOpenBootFailure={onOpenBootFailure}
    />)

    expect(container.textContent).toContain('Service exited before becoming ready.')
    expect(container.textContent).toContain(UNPRESERVED_CAUSE)
    expect(container.textContent).toContain('wrapper exited')
    expect(container.textContent).toContain('Update the outer wrapper')
    // Raw classification and the preserved-output boilerplate stay in the dialog.
    expect(container.textContent).not.toContain('process-exit')
    expect(container.textContent).not.toContain('Canary preserved')
    expect(labels()).toEqual(['cmd', 'cwd', 'ref', 'url', 'Failure excerpt'])

    const buttons = [...container.querySelectorAll('[data-testid="service-boot-failure"] button')] as HTMLButtonElement[]
    expect(buttons.map((button) => button.textContent)).toEqual(['Open service log', 'Show full output'])
    act(() => buttons[0].click())
    expect(openRunLog).toHaveBeenCalledWith('r1', '/logs/service.log')
    act(() => buttons[1].click())
    expect(onOpenBootFailure).toHaveBeenCalledOnce()
  })

  it('previews the first useful evidence window', () => {
    const excerpt = [
      'Container database Running',
      'Container rabbitmq Running',
      'Error: Merchant Pass refused the login with HTTP 401',
      'Unauthorized · /api/v1/user-auth/authorize',
      'at bootstrap (/worktree/start.cjs:24:19)',
      'at async main (/worktree/start.cjs:31:2)',
    ].join('\n')
    render(<Card
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
    expect(failure.textContent).not.toContain('/logs/service.log')
  })

  it('lists the first compiler errors and points at the fix when the build failed', () => {
    const onOpenBootFailure = vi.fn()
    const excerpt = [1, 2, 3, 4, 5].map((n) => `ERROR in ./src/mod${n}/file${n}.ts:${n}:7\nTS2322: Type ${n} is wrong.\n`).join('\n')
    render(<Card
      bootFailure={{
        service: service.name, safeName: service.safeName, reason: 'health-timeout', classification: 'compiler-failure',
        detail: 'Timed out.', logPath: '/logs/service.log', excerpt,
        nextAction: 'Check the health URL, then restart the run.',
      }}
      onOpenBootFailure={onOpenBootFailure}
    />)

    const failure = container.querySelector('[data-testid="service-boot-failure"]')!
    expect(failure.textContent).toContain('Service build failed before it became ready.')
    expect(failure.textContent).toContain(COMPILER_FAILURE_NEXT_ACTION)
    expect(failure.textContent).not.toContain('Check the health URL')
    expect(labels()).toContain('Compiler errors · 5 in preserved output')
    expect([...failure.querySelectorAll('li')].map((row) => row.textContent)).toEqual([1, 2, 3].map((n) => `TS2322src/mod${n}/file${n}.ts:${n}:7Type ${n} is wrong.`))
    act(() => [...failure.querySelectorAll('button')].find((button) => button.textContent === 'Show all 5')!.click())
    expect(onOpenBootFailure).toHaveBeenCalledOnce()
  })

  it('holds the ref and url rows open with a placeholder when there is nothing to show', () => {
    render(<Card service={{ ...service, healthUrl: undefined } as ServiceManifestEntry} branch={null} />)

    // Same shape as a fully-populated card — a missing branch is a fact, not a
    // reason for the card to change form.
    expect(labels()).toEqual(['cmd', 'cwd', 'ref', 'url'])
    expect(container.textContent).toContain('—')
  })

  it('starts the title on the card edge, with no status-dot slot indenting it', () => {
    render(<Card />)

    const header = container.querySelector('.cl-card')?.firstElementChild
    expect(header?.firstElementChild?.textContent).toBe('merchant-pass')
  })

  it('never shows the log path — the Services tab streams that log live', () => {
    render(<Card />)

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
