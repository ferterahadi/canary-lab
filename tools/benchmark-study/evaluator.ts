import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { allocatePorts, releasePorts } from '../../apps/web-server/src/features/runs/logic/runtime/port-allocator'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'
import { command, copy, json, prefixedCommand } from './files'
import { services, serviceInvocation, playwrightOutputArgs } from './runtime'
import { sleep } from '../../shared/lib/sleep'
export async function ports(): Promise<Record<string, number>> {
  return Object.fromEntries(await allocatePorts(services.map((name) => ({ name }))))
}
export function testEnvironment(root: string, allocated: Record<string, number>): NodeJS.ProcessEnv {
  return {
    STOREFRONT_STATE_DIR: path.join(root, '.state'), STOREFRONT_CURRENCY: 'SGD', STOREFRONT_WELCOME_CODE: 'WELCOME10',
    ...Object.fromEntries(Object.entries(allocated).map(([key, value]) => [`CANARY_PORT_${key}`, String(value)])),
  }
}
export function dependencies(root: string, studyRoot: string): void {
  fs.mkdirSync(root, { recursive: true })
  fs.symlinkSync(path.join(studyRoot, 'runtime/node_modules'), path.join(root, 'node_modules'), 'dir')
}

export async function withServices<T>(root: string, work: (allocated: Record<string, number>) => Promise<T>, prefix: string[] = []): Promise<T> {
  const allocated = await ports()
  const children: ChildProcess[] = []
  const outputs: number[] = []
  let interrupted = false
  const stop = (): void => {
    interrupted = true
    for (const child of children) signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    for (const name of services) {
      const log = fs.openSync(path.join(root, `${name}.log`), 'a'); outputs.push(log)
      const service = serviceInvocation(name)
      const invocation = prefixedCommand(service.command, service.args, prefix)
      const child = spawn(invocation.command, invocation.args, {
        cwd: path.join(root, 'app'), detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, ...testEnvironment(root, allocated), PORT: String(allocated[name]) },
      })
      children.push(child)
      let spawnError: Error | undefined
      child.on('error', (error) => { spawnError = error })
      const deadline = Date.now() + 30_000
      let ready = false
      while (Date.now() < deadline && !ready) {
        if (interrupted) throw new Error('Evaluator interrupted')
        if (spawnError) throw spawnError
        if (child.exitCode !== null) throw new Error(`${name} exited before readiness; see ${name}.log`)
        try { ready = (await fetch(`http://127.0.0.1:${allocated[name]}/`, { signal: AbortSignal.timeout(500) })).ok }
        catch { /* poll until the service binds its port */ }
        if (!ready) await sleep(100)
      }
      if (!ready) throw new Error(`${name} readiness timed out`)
    }
    return await work(allocated)
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    for (const child of children) signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true })
    for (const fd of outputs) fs.closeSync(fd)
    releasePorts(Object.values(allocated))
  }
}

interface PlaywrightSuite { specs?: Array<{ title: string; tests: Array<{ results: Array<{ status: string }> }> }>; suites?: PlaywrightSuite[] }
export interface TestEvidence { code: number | null; roster: string[]; passed: string[]; failed: string[]; skipped: string[] }
export function parseResults(raw: unknown, code: number | null): TestEvidence {
  const evidence: TestEvidence = { code, roster: [], passed: [], failed: [], skipped: [] }
  const visit = (suite: PlaywrightSuite): void => {
    for (const spec of suite.specs ?? []) {
      evidence.roster.push(spec.title)
      const statuses = spec.tests.flatMap((test) => test.results.map((result) => result.status))
      if (statuses.length > 0 && statuses.every((status) => status === 'passed')) evidence.passed.push(spec.title)
      else if (statuses.some((status) => status !== 'passed' && status !== 'skipped')) evidence.failed.push(spec.title)
      else evidence.skipped.push(spec.title)
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  visit(raw as PlaywrightSuite)
  return evidence
}
export async function runTests(root: string, allocated: Record<string, number>, list = false, prefix: string[] = []): Promise<TestEvidence> {
  const resultFile = path.join(root, list ? 'roster.json' : 'playwright.json')
  const invocation = prefixedCommand(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    '--config', path.join(root, 'suite/playwright.config.ts'), ...playwrightOutputArgs(root), '--reporter=json', '--max-failures=0', ...(list ? ['--list'] : [])], prefix)
  const result = await command(invocation.command, invocation.args, {
    cwd: root, timeoutMs: 180_000, log: path.join(root, 'playwright.log'),
    env: { ...testEnvironment(root, allocated), PLAYWRIGHT_JSON_OUTPUT_NAME: resultFile },
  })
  if (result.timedOut || !fs.existsSync(resultFile)) throw new Error('Playwright did not produce complete JSON evidence')
  const raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (raw.errors?.length) throw new Error(`Playwright infrastructure error: ${JSON.stringify(raw.errors)}`)
  return parseResults(raw, result.code)
}

async function extraChecks(allocated: Record<string, number>): Promise<void> {
  const request = async (service: string, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${allocated[service]}${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  for (const [name, price, quantity] of [['Study Ceramic Cup', 1379, 3], ['Study Tea Spoon', 725, 5]] as const) {
    const product = await request('catalog', '/products', 'POST', { name, priceCents: price })
    assert.equal(product.status, 201)
    assert.equal(product.body.sku, name.toLowerCase().replace(/\s+/g, '-'))
    const cart = await request('checkout', '/carts', 'POST', {})
    assert.equal(cart.status, 201)
    await request('checkout', `/carts/${cart.body.id}/items`, 'POST', { sku: product.body.sku, unitPrice: price, quantity })
    const discount = await request('checkout', `/carts/${cart.body.id}/discount`, 'POST', { code: 'WELCOME10' })
    assert.equal(discount.body.total, Math.round(price * quantity * 0.9))
    const replace = await request('checkout', `/carts/${cart.body.id}/discount`, 'POST', { code: 'HALFOFF' })
    assert.equal(replace.body.total, Math.round(price * quantity * 0.5))
  }
  for (const quantity of [1, 3]) {
    const before = await request('inventory', '/stock/espresso-beans')
    const after = await request('inventory', '/stock/espresso-beans/reserve', 'POST', { quantity })
    assert.equal(after.status, 200)
    assert.equal(after.body.available, before.body.available - quantity)
  }
}

export async function evaluate(studyRoot: string, app: string, suite: string, output: string, extra = false): Promise<TestEvidence & { extras: boolean | null }> {
  if (fs.existsSync(output)) throw new Error(`Evaluator output already exists: ${output}`)
  copy(app, path.join(output, 'app')); copy(suite, path.join(output, 'suite')); dependencies(output, studyRoot)
  return withServices(output, async (allocated) => {
    const tests = await runTests(output, allocated)
    let extras: boolean | null = null
    if (extra) {
      try { await extraChecks(allocated); extras = true }
      catch (error) { extras = false; json(path.join(output, 'extra-error.json'), { error: String(error) }) }
    }
    const result = { ...tests, extras }
    json(path.join(output, 'verdict.json'), result)
    return result
  })
}
