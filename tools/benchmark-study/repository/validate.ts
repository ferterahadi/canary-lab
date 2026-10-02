import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { signalProcessTree } from '../../../apps/web-server/src/shared/process-tree'
import { checked, command, copy, json, readJson, sourceRoot } from '../files'
import { parseResults, type TestEvidence } from '../evaluator'
import { loadRepositoryStudy, repositoryScenarios, subjectPackageName, type RepositoryScenario, type RepositoryStudyManifest } from './adapter'

async function requireFreePort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => reject(new Error(`Fixture port 3411 is unavailable: ${String(error)}`)))
    server.listen(3411, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}

async function waitForHost(child: ChildProcess, spawnError: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const error = spawnError()
    if (error) throw error
    if (child.exitCode !== null) throw new Error(`Fixture host exited before readiness: ${child.exitCode}`)
    try {
      const response = await fetch('http://127.0.0.1:3411/api/v1/users/me', { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* The host may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Fixture host readiness timed out')
}

export const oracleTitles = [
  'default/toon-encoded tool: content[0].text TOON-decodes back to the original array',
  "encoding:'json' tool: content[0].text is exact JSON.stringify(value)",
] as const

export interface OracleSpec { title: string; tests: Array<{ status: string; results: Array<{ status: string; error?: { message?: string }; errors?: Array<{ message?: string }> }> }> }
interface OracleSuite { specs?: OracleSpec[]; suites?: OracleSuite[] }
export interface OracleReport extends OracleSuite { errors?: unknown[] }

function oracleSpecs(report: OracleSuite): OracleSpec[] {
  return [...report.specs ?? [], ...(report.suites ?? []).flatMap(oracleSpecs)]
}

export function repositoryOracleSpecs(evidence: TestEvidence, report: OracleReport): OracleSpec[] {
  const specs = oracleSpecs(report)
  if (report.errors?.length || evidence.roster.length !== 2 || new Set(evidence.roster).size !== 2 ||
      JSON.stringify(evidence.roster) !== JSON.stringify(oracleTitles) || evidence.skipped.length ||
      specs.length !== 2 || specs.some((spec, index) => spec.title !== oracleTitles[index] ||
        spec.tests.length !== 1 || spec.tests[0].results.length !== 1)) {
    throw new Error('Repository oracle roster or result shape or infrastructure changed')
  }
  return specs
}

export function assertExpectedEvidence(scenario: RepositoryScenario, evidence: TestEvidence, report: OracleReport): void {
  const specs = repositoryOracleSpecs(evidence, report)
  const expected = scenario === 'clean' ? evidence.passed : evidence.failed
  if (expected.length !== 2 || (scenario === 'clean' ? evidence.code !== 0 || evidence.failed.length !== 0 : evidence.code !== 1 || evidence.passed.length !== 0)) {
    throw new Error(`Repository ${scenario} oracle drift: ${JSON.stringify({ evidence, errors: report.errors })}`)
  }
  if (specs.some((spec) => spec.tests[0].status !== (scenario === 'clean' ? 'expected' : 'unexpected') ||
      spec.tests[0].results[0].status !== (scenario === 'clean' ? 'passed' : 'failed'))) {
    throw new Error(`Repository ${scenario} oracle roster or result shape changed`)
  }
  if (scenario === 'clean') {
    if (specs.some((spec) => spec.tests[0].results[0].error || spec.tests[0].results[0].errors?.length)) {
      throw new Error('Clean oracle contains a test error')
    }
    return
  }
  const results = specs.map((spec) => spec.tests[0].results[0])
  const cleanMessage = (message: string): string => message.replace(/\x1b\[[0-9;]*m/g, '')
  const messages = results.map((result) => cleanMessage(result.error?.message ?? ''))
  const signatures = scenario === 'overlap'
    ? [/toEqual\(expected\)[\s\S]*"row-2"/, /toBe\(expected\)[\s\S]*Expected:[\s\S]*row-2[\s\S]*Received:[\s\S]*row-1/]
    : [/toThrow\(\)[\s\S]*Received function did not throw/, /toBe\(expected\)[\s\S]*Received[\s\S]*\[2\]\{id,label\}:/]
  if (messages.some((message, index) => results[index].errors?.length !== 1 ||
      !cleanMessage(results[index].errors![0].message ?? '').includes(message) ||
      !signatures[index].test(message) || /Timeout|ECONN|ENOENT|net::ERR_/i.test(results[index].errors![0].message ?? ''))) {
    throw new Error(`Repository ${scenario} failed for an unexpected reason`)
  }
}

export async function withRepositoryHost<T>(args: { cwd: string; executable: string; argv: string[]; env: NodeJS.ProcessEnv; log: string },
  work: () => Promise<T>): Promise<T> {
  await requireFreePort()
  const log = fs.openSync(args.log, 'a')
  const child = spawn(args.executable, args.argv, {
    cwd: args.cwd, detached: true, stdio: ['ignore', log, log], env: args.env,
  })
  let spawnError: Error | undefined
  child.once('error', (error) => { spawnError = error })
  try {
    await waitForHost(child, () => spawnError)
    if (spawnError) throw spawnError
    return await work()
  } finally {
    signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true })
    if (child.exitCode === null) await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
    fs.closeSync(log)
  }
}

export async function runRepositoryOracle(output: string, playwrightModules: string, env: NodeJS.ProcessEnv, inheritEnv = true):
Promise<{ report: OracleReport; evidence: TestEvidence }> {
  const resultFile = path.join(output, 'playwright.json')
  const result = await command(process.execPath, [path.join(playwrightModules, '@playwright/test/cli.js'), 'test',
    '--config', path.join(output, 'suite/playwright.config.ts'), '--output', path.join(output, 'test-results'),
    '--reporter=json', '--max-failures=0'], {
    cwd: output, timeoutMs: 180_000, log: path.join(output, 'playwright.log'),
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: resultFile }, inheritEnv,
  })
  if (result.timedOut || !fs.existsSync(resultFile)) throw new Error('Repository oracle did not produce complete JSON evidence')
  const report = readJson<OracleReport>(resultFile)
  return { report, evidence: parseResults(report, result.code) }
}

async function evaluateSnapshot(manifest: RepositoryStudyManifest, scenario: RepositoryScenario, playwrightModules: string, yarnCacheFolder?: string):
Promise<Omit<TestEvidence, 'code'> & { code: number; evidence: string }> {
  const output = path.join(manifest.root, 'evaluation', scenario)
  if (fs.existsSync(output)) throw new Error(`Evaluator output already exists: ${output}`)
  const fixture = path.join(manifest.root, 'frozen/fixture')
  const attempt = path.join(manifest.root, 'attempts', scenario)
  copy(path.join(attempt, 'source'), path.join(output, 'source'))
  fs.rmSync(path.join(output, 'source/dist'), { recursive: true, force: true })
  copy(path.join(fixture, 'host'), path.join(output, 'host'))
  copy(path.join(fixture, 'package-stub'), path.join(output, 'package-stub'))
  copy(path.join(fixture, 'oracle'), path.join(output, 'suite'))
  fs.symlinkSync(playwrightModules, path.join(output, 'node_modules'), 'dir')
  const env = yarnCacheFolder ? { YARN_CACHE_FOLDER: fs.realpathSync(yarnCacheFolder) } : undefined
  for (const [directory, args] of [
    ['source', ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']],
    ['source', ['build']],
    ['host', ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']],
  ] as const) {
    const result = await command('yarn', [...args], { cwd: path.join(output, directory), env, timeoutMs: 120_000, log: path.join(output, `${directory}-${args[0]}.log`) })
    if (result.code !== 0 || result.timedOut) throw new Error(`Evaluator ${scenario} ${directory} ${args[0]} failed; see ${output}`)
  }
  const packageLink = path.join(output, 'host/node_modules', subjectPackageName(path.join(output, 'source')))
  fs.rmSync(packageLink, { recursive: true, force: true })
  fs.symlinkSync(path.join(output, 'source'), packageLink, 'dir')
  fs.copyFileSync(path.join(output, 'host/fixture.env'), path.join(output, 'host/.env.local'))
  return withRepositoryHost({ cwd: path.join(output, 'host'), executable: process.execPath,
    argv: [path.join(output, 'host/node_modules/next/dist/bin/next'), 'dev', '-p', '3411', '-H', '127.0.0.1'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, log: path.join(output, 'host.log') }, async () => {
    const { report, evidence } = await runRepositoryOracle(output, playwrightModules, {}, true)
    assertExpectedEvidence(scenario, evidence, report)
    if (evidence.code === null) throw new Error(`Repository ${scenario} oracle exited without a code`)
    const receipt = { ...evidence, code: evidence.code, evidence: path.relative(manifest.root, output) }
    json(path.join(output, 'verdict.json'), receipt)
    return receipt
  })
}

export async function validateRepositoryStudy(root: string, playwrightNodeModules: string, yarnCacheFolder?: string): Promise<RepositoryStudyManifest> {
  const manifest = loadRepositoryStudy(root)
  if (await checked('yarn', ['--version'], sourceRoot) !== manifest.yarnVersion) throw new Error('Yarn version changed since repository preparation')
  if (!manifest.isolation || repositoryScenarios.some((scenario) => manifest.isolation?.[scenario]?.osSandbox !== 'passed')) {
    throw new Error('Repository isolation probes must pass before local validation')
  }
  const playwrightModules = fs.realpathSync(playwrightNodeModules)
  if (!fs.existsSync(path.join(playwrightModules, '@playwright/test/cli.js'))) throw new Error('Playwright runtime is missing its CLI')
  const packageVersion = (file: string): string => readJson<{ version: string }>(file).version
  const clean = path.join(manifest.root, 'attempts/clean')
  manifest.validationRuntime = {
    playwrightModules, playwrightVersion: packageVersion(path.join(playwrightModules, '@playwright/test/package.json')),
    nextVersion: packageVersion(path.join(clean, 'host/node_modules/next/package.json')),
    mcpSdkVersion: packageVersion(path.join(clean, 'source/node_modules/@modelcontextprotocol/sdk/package.json')),
    toonVersion: packageVersion(path.join(clean, 'source/node_modules/@toon-format/toon/package.json')),
    dependencyBytes: 'unverified',
  }
  const validation = {} as NonNullable<RepositoryStudyManifest['validation']>
  let cleanRoster: string[] | null = null
  for (const scenario of repositoryScenarios) {
    const evidence = await evaluateSnapshot(manifest, scenario, playwrightModules, yarnCacheFolder)
    if (cleanRoster && JSON.stringify(evidence.roster) !== JSON.stringify(cleanRoster)) throw new Error(`Repository ${scenario} declared test roster changed`)
    cleanRoster ??= evidence.roster
    validation[scenario] = evidence
    manifest.validation = validation
    json(path.join(manifest.root, 'repository-study.json'), manifest)
  }
  manifest.status = 'validated'
  json(path.join(manifest.root, 'repository-study.json'), manifest)
  return manifest
}
