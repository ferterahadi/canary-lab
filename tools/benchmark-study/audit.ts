import fs from 'node:fs'
import path from 'node:path'
import { attributeUsage, type SessionInput } from './attribution'
import { inside, json, readJson, sha, write } from './files'
import { totalTokens } from './usage'
import type { StudyManifest, UsageAttribution } from './types'

interface SessionIndexEntry { sessionId: string; evidence: string; parentSessionId?: string; parentToolId?: string }

export function auditStudy(study: string, output: string): void {
  const root = fs.realpathSync(study)
  const destination = path.resolve(output)
  if (inside(root, destination) || inside(destination, root) || fs.existsSync(destination)) throw new Error('Audit output must be a new directory outside the historical study')
  const manifest = readJson<StudyManifest>(path.join(root, 'study.json'))
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported historical manifest')
  const before = sha(fs.readFileSync(path.join(root, 'study.json')))
  const attempts = manifest.results.map((result) => {
    if (!/^[a-zA-Z0-9-]+$/.test(result.id)) throw new Error('Invalid historical attempt identity')
    const attemptRoot = path.join(root, 'attempts', result.id)
    const indexFile = path.join(attemptRoot, 'sessions/index.json')
    const index = fs.existsSync(indexFile) ? readJson<SessionIndexEntry[]>(indexFile) : []
    const inputs: SessionInput[] = index.map((entry) => {
      const source = path.resolve(attemptRoot, entry.evidence, 'session.jsonl')
      if (!inside(attemptRoot, source)) throw new Error('Session evidence path escapes its attempt')
      const raw = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : null
      const evidence = `sessions/${result.id}/${path.basename(entry.sessionId)}.jsonl`
      if (raw !== null) write(path.join(destination, evidence), raw)
      return { ...entry, evidence, raw }
    })
    const attribution: UsageAttribution = attributeUsage(result.agent, inputs)
    const recordedTokens = totalTokens(result.agent, result.usage)
    const nativeTokens = totalTokens(result.agent, attribution.total)
    const reconciliation = recordedTokens === null || nativeTokens === null ? 'unknown' : recordedTokens === nativeTokens ? 'matches' : 'mismatch'
    return { id: result.id, agent: result.agent, workflow: result.workflow, scenario: result.scenario, outcome: result.outcome,
      recordedTokens, nativeTokens, reconciliation, attribution,
      timing: result.timing ?? null, missingHistoricalMeasurements: ['exclusive critical path', 'parent waiting intervals', 'semantic policy adherence', 'duplicated reads and proposed patches'] }
  })
  const audit = { source: root, sourceManifestDigest: before, createdAt: new Date().toISOString(), attempts }
  json(path.join(destination, 'audit.json'), audit)
  const rows = attempts.map((attempt) => `| ${attempt.id} | ${attempt.outcome} | ${attempt.recordedTokens ?? 'unknown'} | ${attempt.nativeTokens ?? 'unknown'} | ${attempt.reconciliation} | ${attempt.attribution.sessions.map((s) => `${s.role}: ${s.sessionId}`).join('; ')} |`)
  write(path.join(destination, 'README.md'), '# Native session attribution audit\n\nRead-only audit of historical receipts. Native logs were copied alongside this audit; no model calls occurred. Missing measurements remain unknown.\n\n' +
    '| Attempt | Outcome | Receipt tokens | Native tokens | Reconciliation | Sessions |\n| --- | --- | ---: | ---: | --- | --- |\n' + rows.join('\n') + '\n\nSee [audit.json](audit.json) for every session, parent, usage component, missing entry and evidence path. Historical stage boundaries and semantic compliance cannot be recovered from aggregate totals.\n')
  if (sha(fs.readFileSync(path.join(root, 'study.json'))) !== before) throw new Error('Historical manifest changed during audit')
}
