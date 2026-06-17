import fs from 'fs'
import path from 'path'
import { docsDirFor } from './docs-collection'
import type { ProposedMapping } from './annotate-engine'

// Persistence for agent-proposed `covers` mappings awaiting human accept/reject.
// When the review flag is ON, the annotate-pass stores proposals here instead of
// writing tags straight away; the UI/MCP then accepts (→ writes the tag) or
// rejects (→ drops it). Stored as a JSON sidecar in docs/ so it travels with the
// feature; it's a `.json`, so the docs-collection hash (md-only) never sees it.

export const MAPPINGS_JSON = '_coverage-mappings.json'

export interface CoverageMappingsStore {
  generatedAt: string
  /** Proposals still awaiting a decision. Keyed by testName at accept/reject. */
  proposals: ProposedMapping[]
}

function storePath(featureDir: string): string {
  return path.join(docsDirFor(featureDir), MAPPINGS_JSON)
}

export function readProposedMappings(featureDir: string): CoverageMappingsStore | null {
  const file = storePath(featureDir)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CoverageMappingsStore
    if (!Array.isArray(parsed.proposals)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeProposedMappings(featureDir: string, store: CoverageMappingsStore): CoverageMappingsStore {
  const docsDir = docsDirFor(featureDir)
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(storePath(featureDir), JSON.stringify(store, null, 2) + '\n')
  return store
}

export function clearProposedMappings(featureDir: string): void {
  const file = storePath(featureDir)
  if (fs.existsSync(file)) fs.rmSync(file)
}

/** Find a pending proposal by test name (first match). */
export function findProposal(store: CoverageMappingsStore | null, testName: string): ProposedMapping | undefined {
  return store?.proposals.find((p) => p.testName === testName)
}

/** Return a new store with the named proposal removed; writes (or clears when the
 *  last one goes) back to disk. Returns the dropped proposal, or undefined. */
export function removeProposal(featureDir: string, testName: string): ProposedMapping | undefined {
  const store = readProposedMappings(featureDir)
  if (!store) return undefined
  const dropped = store.proposals.find((p) => p.testName === testName)
  if (!dropped) return undefined
  const remaining = store.proposals.filter((p) => p.testName !== testName)
  if (remaining.length) writeProposedMappings(featureDir, { ...store, proposals: remaining })
  else clearProposedMappings(featureDir)
  return dropped
}
