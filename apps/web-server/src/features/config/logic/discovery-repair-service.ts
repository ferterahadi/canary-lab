import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import { discoveryRepairActive, type DiscoveryRepair, type DiscoveryRepairOwner } from '../../../../../../shared/discovery-repair'
import { loadFeatures } from '../../../shared/feature-loader'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { bridgeStoreEvents } from '../../../shared/store-event-bridge'
import { listPlaywrightTests, type PlaywrightListEntry } from '../../runs/logic/playwright-list'
import { envsetProcessEnv } from '../routes/features'
import { buildDiscoveryRepairPrompt } from './discovery-repair-prompt'
import { discoveryRepairStore } from './discovery-repair-store'
import { runDiscoveryRepairAgent } from './discovery-repair-agent'

interface Dependencies {
  projectRoot: string
  featuresDir: string
  logsDir: string
  workspaceEvents?: WorkspaceEventPublisher
  listTests?: (feature: FeatureConfig, diagnostics: (message: string) => void) => Promise<PlaywrightListEntry[] | null>
  runAgent?: typeof runDiscoveryRepairAgent
}

export class DiscoveryRepairService {
  readonly store
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly deps: Dependencies) {
    this.store = discoveryRepairStore(deps.logsDir)
    bridgeStoreEvents(this.store, deps.workspaceEvents, (event) => {
      const repair = this.store.get(event.id)
      return repair ? { type: 'discovery-repair-changed', feature: repair.feature } : null
    })
    bridgeStoreEvents(this.store, deps.workspaceEvents, (event) => {
      const repair = this.store.get(event.id)
      return repair?.status === 'succeeded' ? { type: 'tests-changed', feature: repair.feature } : null
    })
  }

  list(feature: string): DiscoveryRepair[] {
    return this.store.list().filter((r) => r.feature === feature).flatMap((r) => {
      const repair = this.store.get(r.id)
      return repair ? [repair] : []
    })
  }

  get(id: string): DiscoveryRepair {
    if (!/^dr_[a-f0-9]{24}$/.test(id)) throw Object.assign(new Error('Invalid repair id'), { statusCode: 400 })
    const repair = this.store.get(id)
    if (!repair) throw Object.assign(new Error('Discovery repair not found'), { statusCode: 404 })
    return repair
  }

  private feature(name: string): FeatureConfig {
    const feature = loadFeatures(this.deps.featuresDir).find((f) => f.name === name)
    if (!feature) throw Object.assign(new Error('Feature not found'), { statusCode: 404 })
    return feature
  }

  private save(repair: DiscoveryRepair): DiscoveryRepair {
    repair.updatedAt = new Date().toISOString()
    this.store.save(repair)
    return repair
  }

  private detach(repair: DiscoveryRepair, work: () => Promise<void>): void {
    const completion = work().catch((err: unknown) => {
      const current = this.get(repair.id)
      const message = err instanceof Error ? err.message : String(err)
      this.save({ ...current, status: 'failed', endedAt: new Date().toISOString(), diagnostic: message, message, log: [...current.log, `[Canary] ${message}`] })
    })
    this.pending.add(completion)
    void completion.finally(() => this.pending.delete(completion)).catch(() => { /* Persistence errors are surfaced by the pending work's rejection. */ })
  }

  async settled(): Promise<void> { await Promise.all(this.pending) }

  start(featureName: string, owner: DiscoveryRepairOwner): DiscoveryRepair {
    const feature = this.feature(featureName)
    const active = this.list(featureName).find(discoveryRepairActive)
    if (active) {
      if (owner.kind === 'internal' || (active.owner.kind === 'external' && active.owner.sessionId === owner.sessionId)) return active
      throw Object.assign(new Error('Another agent owns this discovery repair. Continue that session before starting another.'), { statusCode: 409 })
    }
    const id = `dr_${crypto.randomBytes(12).toString('hex')}`
    const now = new Date().toISOString()
    const repair = this.save({ id, feature: featureName, featureDir: feature.featureDir, owner, status: 'repairing', createdAt: now, updatedAt: now, heartbeatAt: now, diagnostic: '', message: 'Checking the discovery error', log: ['[Canary] Checking current test discovery.'], promptPath: path.join(this.store.recordDir(id), 'prompt.md') })
    // Reserve ownership before the first asynchronous discovery check.
    this.detach(repair, async () => {
      let diagnostic = ''
      const tests = await this.discover(feature, (text) => { diagnostic = text })
      if (tests !== null && tests.length > 0) {
        try { this.checkRoster(repair, tests) }
        catch (err) { diagnostic = err instanceof Error ? err.message : String(err) }
        if (!diagnostic) { this.succeed(repair.id, tests); return }
      }
      if (tests?.length === 0) diagnostic = 'Discovery returned no test cases. Restore the complete suite.'
      fs.writeFileSync(repair.promptPath, buildDiscoveryRepairPrompt(feature, diagnostic))
      const ready = this.save({ ...this.get(id), diagnostic, message: owner.kind === 'external' ? 'Waiting for your agent to inspect the error' : 'Repairing discovery', log: [...repair.log, '[Canary] Discovery failed; repair instructions are ready.'] })
      if (owner.kind === 'external') return
      await (this.deps.runAgent ?? runDiscoveryRepairAgent)(ready, this.deps.projectRoot, (sessionRef) => this.save({ ...this.get(id), sessionRef }))
      await this.verify(id)
    })
    return repair
  }

  update(id: string, sessionId: string, action: 'progress' | 'verify' | 'blocked', message?: string): DiscoveryRepair {
    const repair = this.get(id)
    if (repair.owner.kind !== 'external' || repair.owner.sessionId !== sessionId) throw Object.assign(new Error('This session does not own the repair'), { statusCode: 409 })
    if (!discoveryRepairActive(repair)) return repair
    if (repair.status === 'verifying') return repair
    if (!fs.existsSync(repair.promptPath)) throw Object.assign(new Error('Discovery is still being inspected. Read the repair again before editing.'), { statusCode: 409 })
    const now = new Date().toISOString()
    const updated = this.save({ ...repair, heartbeatAt: now,
      ...(message ? { message, log: [...repair.log, `[agent-report] ${message}`] } : {}),
      ...(action === 'blocked' ? { status: 'failed' as const, endedAt: now, diagnostic: message ?? 'External repair stopped; inspect its activity.' } : {}),
    })
    if (action === 'verify') {
      const verifying = this.save({ ...updated, status: 'verifying', message: 'Canary is verifying discovery', log: [...updated.log, '[Canary] Listing tests; no test bodies will run.'] })
      this.detach(verifying, () => this.verify(id))
      return verifying
    }
    return updated
  }

  private discover(feature: FeatureConfig, diagnostics: (message: string) => void) {
    return this.deps.listTests
      ? this.deps.listTests(feature, diagnostics)
      : listPlaywrightTests(feature.featureDir, { fresh: true, onDiagnostics: diagnostics, env: envsetProcessEnv(feature.featureDir, feature.envs?.[0], (err) => diagnostics(String(err))) })
  }

  private async verify(id: string): Promise<void> {
    const repair = this.get(id)
    if (repair.status !== 'verifying') this.save({ ...repair, status: 'verifying', message: 'Canary is verifying discovery', log: [...repair.log, '[Canary] Listing tests; no test bodies will run.'] })
    let diagnostic = ''
    const tests = await this.discover(this.feature(repair.feature), (message) => { diagnostic = message })
    if (tests === null) throw new Error(diagnostic || 'Playwright could not enumerate the test cases')
    if (tests.length === 0) throw new Error('Discovery returned no test cases. Review the suite before retrying.')
    this.succeed(id, tests)
  }

  private checkRoster(repair: DiscoveryRepair, tests: PlaywrightListEntry[]): void {
    const previous = this.list(repair.feature).find((r) => r.id !== repair.id && r.status === 'succeeded')
    if (previous) {
      const roster = JSON.parse(fs.readFileSync(path.join(this.store.recordDir(previous.id), 'discovered-tests.json'), 'utf8')) as PlaywrightListEntry[]
      // Line numbers move during import/setup repairs. Match case identity and
      // multiplicity instead, so removing a duplicate case is also detected.
      const key = (test: PlaywrightListEntry) => JSON.stringify([path.relative(repair.featureDir, test.file), test.title])
      const remaining = new Map<string, number>()
      for (const test of tests) remaining.set(key(test), (remaining.get(key(test)) ?? 0) + 1)
      for (const test of roster) {
        const count = remaining.get(key(test)) ?? 0
        if (count === 0) throw new Error(`Discovery is missing a previously recorded case: ${test.title}. Restore the complete suite before retrying.`)
        remaining.set(key(test), count - 1)
      }
    }
  }

  private succeed(id: string, tests: PlaywrightListEntry[]): void {
    if (tests.length === 0) throw new Error('Discovery returned no test cases. Review the suite before retrying.')
    const repair = this.get(id)
    this.checkRoster(repair, tests)
    fs.writeFileSync(path.join(this.store.recordDir(id), 'discovered-tests.json'), JSON.stringify(tests, null, 2))
    this.save({ ...repair, status: 'succeeded', endedAt: new Date().toISOString(), discoveredCount: tests.length, message: `${tests.length} tests discovered`, log: [...repair.log, `[Canary] ${tests.length} tests discovered. Test bodies were not executed.`] })
  }
}
