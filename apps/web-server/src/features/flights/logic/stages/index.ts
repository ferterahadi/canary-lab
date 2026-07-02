import type { StageAdapters } from '../conductor'
import type { FlightStageDeps } from './context'
import { similarityStage } from './similarity'
import { scoutStage } from './scout'
import { scaffoldStage } from './scaffold'
import { envCaptureStage } from './env-capture'
import { docsStage } from './docs'
import { prdSummaryStage } from './prd-summary'
import { specsCoverageStage } from './specs-coverage'
import { portifyStage } from './portify'
import { runStage, healStage } from './run'
import { evaluationExportStage } from './evaluation-export'

export type { FlightStageDeps, FlightInject, FlightAgentSpawner } from './context'

// The flight's stage adapters — each a thin conductor over an existing
// subsystem (create_feature scaffolding, env capture, PRD/coverage engines,
// draft-apply validation, portify, runs, evaluation export). No new engines:
// an adapter orchestrates and computes the harness-side success predicate;
// it never lets a stage settle on agent say-so. The contract each adapter
// implements is the project doc research/flight-stages.md (todo hub →
// canary-first-flight).

export function buildFlightStageAdapters(deps: FlightStageDeps): StageAdapters {
  return {
    'similarity': similarityStage(deps),
    'scout': scoutStage(deps),
    'scaffold': scaffoldStage(deps),
    'env-capture': envCaptureStage(deps),
    'docs': docsStage(deps),
    'prd-summary': prdSummaryStage(deps),
    'specs-coverage': specsCoverageStage(deps),
    'portify': portifyStage(deps),
    'run': runStage(deps),
    'heal': healStage(deps),
    'evaluation-export': evaluationExportStage(deps),
  }
}
