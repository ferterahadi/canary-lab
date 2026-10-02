import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { json, readJson, write } from '../files'
import type { Attempt, StudyManifest } from '../types'
import { evaluateRepositoryCandidate, verifyCandidateSource, type CandidateReceipt } from './candidate'
import type { FailureDiagnostic } from './failure-context'

export function assertionDiagnostics(file: string): FailureDiagnostic[] {
  const report = readJson<unknown>(file)
  const found: FailureDiagnostic[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const node = value as { title?: string; tests?: Array<{ results?: Array<{ error?: { message?: string }; errors?: Array<{ message?: string }> }> }> }
    if (node.title && Array.isArray(node.tests)) found.push({ title: node.title, messages: node.tests.flatMap((test) =>
      (test.results ?? []).flatMap((result) => [result.error, ...(result.errors ?? [])].flatMap((error) => error?.message ? [error.message.slice(0, 4000)] : []))) })
    for (const child of Object.values(value)) if (typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(report)
  return found
}

export async function startRepositoryCheckBroker(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal,
  evaluate: typeof evaluateRepositoryCandidate = evaluateRepositoryCandidate) {
  const repository = manifest.repository!
  const capability = randomBytes(32).toString('hex')
  let count = 0
  let executions = 0
  let active: Promise<void> | undefined
  let failure: string | undefined
  let closing = false
  const checks = new Set<string>()
  const server = http.createServer((request, response) => {
    const reply = (status: number, value: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.headers.authorization !== `Bearer ${capability}`) { reply(403, { error: 'Invalid attempt capability' }); return }
    if (request.method === 'GET' && request.url === '/checks') {
      reply(200, [...checks].map((id) => ({ checkId: id, ...readJson<object>(path.join(manifest.root, 'receipts', `${id}.json`)) }))); return
    }
    const checkId = request.url?.startsWith('/checks/') ? request.url.slice('/checks/'.length) : ''
    if (request.method === 'GET' && checks.has(checkId)) {
      reply(200, readJson(path.join(manifest.root, 'receipts', `${checkId}.json`))); return
    }
    if (request.method !== 'POST' || request.url !== '/check') { reply(404, { error: 'Unknown check operation' }); return }
    if (active) { reply(409, { error: 'A candidate check is already running' }); return }
    if (closing || signal.aborted || failure) { reply(503, { error: failure ?? 'Attempt interrupted' }); return }
    if (count >= repository.maxChecks) { reply(429, { error: 'Frozen check limit reached' }); return }
    const index = ++count
    const evaluationId = `${attempt.id}-check-${index}`
    const startedAt = new Date().toISOString()
    checks.add(evaluationId)
    json(path.join(manifest.root, 'receipts', `${evaluationId}.json`), { startedAt, status: 'running', checkId: evaluationId })
    reply(202, { checkId: evaluationId, status: 'running' })
    // The endpoint takes no candidate path, scenario, command, or evaluator
    // options from the agent. Its capability binds exactly one attempt.
    active = (async () => {
      try {
        const receipt: CandidateReceipt = await evaluate({ study: manifest.root, scenario: attempt.scenario as 'overlap' | 'independent',
          candidate: path.join(root, 'app'), playwrightNodeModules: path.join(manifest.root, 'runtime/node_modules'),
          yarnCacheFolder: repository.yarnCacheFolder, signal, campaign: { attemptId: attempt.id, evaluationId } })
        executions++
        const current = verifyCandidateSource(path.join(root, 'app'), path.join(manifest.root, 'attempts', attempt.scenario, 'source'))
        const result = { status: receipt.status, candidateDigest: receipt.candidateDigest, fresh: current.digest === receipt.candidateDigest,
          roster: receipt.roster, passed: receipt.passed, failed: receipt.failed, skipped: receipt.skipped,
          diagnostics: assertionDiagnostics(path.join(manifest.root, receipt.evidence)) }
        json(path.join(manifest.root, 'receipts', `${evaluationId}.json`), { startedAt, completedAt: new Date().toISOString(), ...result })
      } catch (error) {
        failure = String(error)
        json(path.join(manifest.root, 'receipts', `${evaluationId}.json`), { startedAt, status: 'invalid', error: failure })
      }
    })().finally(() => { active = undefined })
    active.catch((error) => { failure = String(error) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Repository check broker did not bind localhost')
  const url = `http://127.0.0.1:${address.port}/check`
  write(path.join(root, 'check.cjs'), `const url=${JSON.stringify(url)},headers={authorization:${JSON.stringify(`Bearer ${capability}`)}};
async function main(){if(process.argv.includes('--status')){const response=await fetch(url.replace('/check','/checks'),{headers});if(!response.ok)throw Error('Cannot recover check status');process.stdout.write(JSON.stringify(await response.json())+'\\n');return;}let response=await fetch(url,{method:'POST',headers});let result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));const id=result.checkId;while(result.status==='running'){await new Promise(resolve=>setTimeout(resolve,200));response=await fetch(url.replace('/check','/checks/'+id),{headers});result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));}process.stdout.write(JSON.stringify(result)+'\\n');if(result.status==='invalid')process.exitCode=1;}
main().catch(error=>{process.stderr.write(String(error));process.exitCode=1});\n`)
  return { url, count: () => count, executions: () => failure ? null : executions, failure: () => failure, close: async () => {
    closing = true
    server.closeIdleConnections()
    await active
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  } }
}
