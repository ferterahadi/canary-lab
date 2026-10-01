import fs from 'node:fs'
import path from 'node:path'
import { writeHealIndex } from '../../../apps/web-server/src/features/runs/logic/runtime/heal-index'
import { renderPrompt } from '../../../apps/web-server/src/shared/prompts'
import { json, sha, write, readJson } from '../files'
import type { Agent, ModelPin } from '../types'

export interface FailureDiagnostic { title: string; messages: string[] }
export interface FailureSlice extends FailureDiagnostic { failureId: string; diagnosticPath: string; childPromptPath: string }

export function writeRepositoryFailureContext(root: string, diagnostics: FailureDiagnostic[], agent: Agent, pin: ModelPin): FailureSlice[] {
  if (!diagnostics.length || diagnostics.some((entry) => !entry.title || !entry.messages.length)) throw new Error('Repository diagnosis requires complete failing diagnostics')
  const failures = diagnostics.map((entry, index): FailureSlice => {
    const failureId = `failure-${index + 1}-${sha(entry.title).slice(0, 12)}`
    const diagnosticPath = `failure-context/${failureId}/diagnostic.json`
    const childPromptPath = `failure-context/${failureId}/child-prompt.md`
    json(path.join(root, diagnosticPath), { failureId, ...entry })
    write(path.join(root, childPromptPath), renderPrompt('benchmark-study/repository-child.md', {
      failureId, diagnosticPath, diagnostic: JSON.stringify(entry, null, 2), agent, model: pin.model, effort: pin.effort,
    }))
    return { failureId, ...entry, diagnosticPath, childPromptPath }
  })
  json(path.join(root, 'failure-context.json'), { schemaVersion: 1, failures })
  json(path.join(root, 'diagnosis-ledger.json'), { failures: failures.map(({ failureId, diagnosticPath, childPromptPath }) =>
    ({ failureId, diagnosticPath, childPromptPath, hypothesis: null, status: 'unresolved', childSessionId: null })) })
  // The contributor fixture has diagnostic slices, not production service logs.
  // Reuse the index renderer without consulting another run's history.
  writeHealIndex({ manifest: { repoPaths: ['app/src/'] }, summary: { failed: failures.map((failure) =>
    ({ name: `${failure.failureId}: ${failure.title}`, error: { message: failure.messages.join('\n') },
      errorFile: failure.diagnosticPath, logFiles: [failure.diagnosticPath, failure.childPromptPath] })) },
    healIndexPath: path.join(root, 'heal-index.md'), journalPath: path.join(root, 'diagnosis-journal.md'), previousFailingSlugs: [] })
  return failures
}

export function readRepositoryFailureContext(root: string): FailureSlice[] {
  const { failures } = readJson<{ failures: FailureSlice[] }>(path.join(root, 'failure-context.json'))
  if (!failures.length || !fs.existsSync(path.join(root, 'heal-index.md')) || failures.some((failure) =>
    !fs.existsSync(path.join(root, failure.diagnosticPath)) || !fs.existsSync(path.join(root, failure.childPromptPath)))) {
    throw new Error('Repository failure context is missing or incomplete')
  }
  return failures
}
