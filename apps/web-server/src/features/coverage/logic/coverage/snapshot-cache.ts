import path from 'path'
import { loadFeatures } from '../../../../shared/feature-loader'
import { readRunsIndex } from '../../../runs/logic/runtime/manifest'
import { runDirFor } from '../../../runs/logic/runtime/run-paths'
import { isAuxiliaryExecution } from '../../../../../../../shared/verification'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'
import { computeFeatureCoverage, FeatureNotFoundError } from './service'
import { coverageJobStore } from './jobs/store'
import { coverageRevision } from './freshness'
import { CoverageInputReads, type InputReadMemo } from './input-reads'

type Paths = { featuresDir: string; logsDir: string }
type Context = ReturnType<CoverageSnapshotCache['context']>
type Snapshot = { ledger: CoverageLedger; inputs: CoverageInputReads; metadata: string }

/** Process-owned derived snapshots, never persisted proof. Every reader checks
 * the same inputs; only a changed suite pays for AST/ledger reconstruction. */
export class CoverageSnapshotCache {
  private readonly snapshots = new Map<string, Snapshot>()
  private discovery?: { inputs: CoverageInputReads; features: ReturnType<typeof loadFeatures> }

  constructor(private readonly paths: Paths) {}

  features(): ReturnType<typeof loadFeatures> {
    if (this.discovery?.inputs.unchanged()) return this.discovery.features
    const inputs = new CoverageInputReads()
    if (inputs.exists(this.paths.featuresDir)) {
      for (const entry of inputs.directory(this.paths.featuresDir)) {
        if (!entry.isDirectory()) continue
        for (const name of ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']) {
          inputs.optional(path.join(this.paths.featuresDir, entry.name, name))
        }
      }
    }
    const features = loadFeatures(this.paths.featuresDir)
    if (!inputs.unchanged()) throw new Error('Suite configuration changed during discovery; retrying.')
    this.discovery = { inputs, features }
    return features
  }

  context() {
    return { runs: readRunsIndex(this.paths.logsDir), jobs: coverageJobStore(this.paths.logsDir).list(), memo: new Map() as InputReadMemo }
  }

  private metadata(feature: string, context: Context): string {
    // A different suite's new run/job must not invalidate this suite's ledger.
    return coverageRevision([
      context.runs.filter((run) => run.feature === feature && !isAuxiliaryExecution(run.executionType)),
      context.jobs.filter((job) => job.feature === feature && job.status === 'running'),
    ])
  }

  get(feature: string, featureDir?: string, context = this.context()): CoverageLedger {
    const dir = featureDir ?? this.features().find((item) => item.name === feature)?.featureDir
    if (!dir) throw new FeatureNotFoundError(feature)
    const metadata = coverageRevision([dir, this.metadata(feature, context)])
    const previous = this.snapshots.get(feature)
    if (previous?.metadata === metadata && previous.inputs.unchanged(context.memo)) {
      // Renew only after reading authoritative inputs, not merely serving cache.
      const ledger = { ...previous.ledger, freshness: { ...previous.ledger.freshness!, checkedAt: new Date().toISOString() } }
      previous.ledger = ledger
      return ledger
    }
    const inputs = new CoverageInputReads()
    inputs.tree(path.join(dir, 'docs'), false)
    inputs.tree(path.join(dir, 'e2e'), true)
    inputs.optional(path.join(this.paths.logsDir, 'dirty-specs', feature, 'dirty.json'))
    for (const run of context.runs) {
      if (run.feature !== feature || isAuxiliaryExecution(run.executionType)) continue
      inputs.optional(path.join(runDirFor(this.paths.logsDir, run.runId), 'e2e-summary.json'))
      inputs.optional(path.join(runDirFor(this.paths.logsDir, run.runId), 'manifest.json'))
    }
    const ledger = computeFeatureCoverage({ ...this.paths, feature, featureDir: dir, inputReads: inputs })
    // An editor/runner can write during synchronous calculation from another
    // process. Never stamp a mixed-input ledger as current or cache it as stable.
    if (!inputs.unchanged() || this.metadata(feature, this.context()) !== this.metadata(feature, context)) {
      throw new Error('Coverage inputs changed during calculation; retrying.')
    }
    this.snapshots.set(feature, { ledger, inputs, metadata })
    return ledger
  }

  remove(feature: string): void { this.snapshots.delete(feature) }
  clear(): void { this.snapshots.clear(); this.discovery = undefined }
}
