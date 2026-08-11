import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoBranchSnapshot, ServiceManifestEntry } from '@/shared/api/types'
import { ServiceCard } from './RunServicePanels'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
