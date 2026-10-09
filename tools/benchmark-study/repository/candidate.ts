import fs from 'node:fs'
import path from 'node:path'
import { changed, copy, inside, json, sha } from '../files'
import { loadRepositoryStudy, repositoryScenarios, subjectPackageName, type RepositoryScenario } from './adapter'
import { CandidateContainers, candidateImage } from './container'
import { repositoryOracleSpecs, runRepositoryOracle } from './validate'
import { sleep } from '../../../shared/lib/sleep'

export interface CandidateReceipt {
  schemaVersion: 2
  scenario: RepositoryScenario
  candidateDigest: string
  changedSourceFiles: string[]
  status: 'passed' | 'failed' | 'invalid'
  code: number | null
  roster: string[]
  passed: string[]
  failed: string[]
  skipped: string[]
  containerImage: string
  containerState: string
  containerRecovery: string
  evidence: string
  error?: string
}

function sourceFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (directory: string, relative = ''): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const file = path.join(directory, entry.name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.nlink > 1 && stat.isFile()) {
        throw new Error(`Candidate contains a link or special file: ${name}`)
      }
      if (relative === '' && ['node_modules', 'dist'].includes(entry.name)) {
        if (!stat.isDirectory()) throw new Error(`Candidate generated entry is not a directory: ${name}`)
        continue
      }
      if (['.git', 'node_modules', '.state', 'test-results', 'playwright-report'].includes(entry.name)) {
        throw new Error(`Candidate contains an ignored entry that would not be evaluated: ${name}`)
      }
      if (stat.isDirectory()) visit(file, name)
      else result[name] = sha(fs.readFileSync(file))
    }
  }
  visit(root)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

export function verifyCandidateSource(candidate: string, baseline: string): { digest: string; changedSourceFiles: string[] } {
  const input = sourceFiles(candidate)
  const frozen = sourceFiles(baseline)
  const differences = changed(frozen, input)
  if (differences.some((name) => !name.startsWith('src/'))) {
    throw new Error(`Candidate changes frozen non-source files: ${differences.filter((name) => !name.startsWith('src/')).join(', ')}`)
  }
  if (!input['package.json'] || !input['yarn.lock']) throw new Error('Candidate is missing its frozen package or lockfile')
  return { digest: sha(JSON.stringify(input)), changedSourceFiles: differences }
}

function assertCandidateOracle(report: Parameters<typeof repositoryOracleSpecs>[1], evidence: Parameters<typeof repositoryOracleSpecs>[0]):
  'passed' | 'failed' {
  const specs = repositoryOracleSpecs(evidence, report)
  if (evidence.code !== 0 && evidence.code !== 1) throw new Error('Candidate oracle process did not exit normally')
  if (evidence.passed.length + evidence.failed.length !== 2) throw new Error('Candidate oracle did not classify both tests')
  for (const spec of specs) {
    const test = spec.tests[0]
    const result = test.results[0]
    if (result.status === 'passed' && test.status === 'expected' && !result.error && !result.errors?.length) continue
    const message = result.error?.message ?? result.errors?.[0]?.message ?? ''
    if (result.status !== 'failed' || test.status !== 'unexpected' || !message ||
        /Timeout|ECONN|ENOENT|net::ERR_|Error: socket hang up/i.test(message)) {
      throw new Error('Candidate oracle failed for infrastructure or an incomplete assertion')
    }
  }
  if (evidence.failed.length === 0 && evidence.code !== 0 || evidence.failed.length > 0 && evidence.code !== 1) {
    throw new Error('Candidate oracle exit code conflicts with its tests')
  }
  return evidence.failed.length === 0 ? 'passed' : 'failed'
}

async function verifyContainerSource(containers: CandidateContainers, id: string, expected: Record<string, string>): Promise<void> {
  const script = `const fs=require('fs'),path=require('path'),crypto=require('crypto');const out={};function visit(dir,rel=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=rel?rel+'/'+entry.name:entry.name;const file=path.join(dir,entry.name);const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isDirectory()&&!st.isFile()||st.isFile()&&st.nlink>1)throw Error('unsafe source '+name);if(!rel&&['dist','node_modules'].includes(entry.name))continue;if(st.isDirectory())visit(file,name);else out[name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}visit('/source');process.stdout.write(JSON.stringify(out))`
  const actual = JSON.parse(await containers.exec(id, ['node', '-e', script])) as Record<string, string>
  const differences = changed(expected, actual)
  if (differences.length) throw new Error(`Container source changed: ${differences.join(', ')}`)
}

async function waitForContainerHost(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Candidate evaluation interrupted')
    try {
      const response = await fetch('http://127.0.0.1:3411/api/v1/users/me', { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* The container host may still be starting. */ }
    await sleep(200)
  }
  throw new Error('Container fixture host readiness timed out')
}

export async function evaluateRepositoryCandidate(options: { study: string; scenario: RepositoryScenario; candidate: string;
  playwrightNodeModules: string; yarnCacheFolder: string; signal?: AbortSignal;
  campaign?: { attemptId: string; evaluationId: string } }): Promise<CandidateReceipt> {
  const manifest = loadRepositoryStudy(options.study)
  if (manifest.status !== 'validated' || !repositoryScenarios.includes(options.scenario)) {
    throw new Error('Candidate evaluation requires a validated study and known scenario')
  }
  const candidate = fs.realpathSync(options.candidate)
  if (options.campaign && (![options.campaign.attemptId, options.campaign.evaluationId].every((id) => /^[a-z][a-z0-9-]{0,120}$/.test(id)) ||
      repositoryScenarios.includes(options.campaign.attemptId as RepositoryScenario))) throw new Error('Invalid campaign evaluation identity')
  const attempt = path.join(manifest.root, 'attempts', options.campaign?.attemptId ?? options.scenario)
  if (!inside(attempt, candidate) || candidate === attempt || inside(path.join(manifest.root, 'frozen'), candidate)) {
    throw new Error('Candidate source must be inside its scenario attempt')
  }
  const baseline = path.join(manifest.root, 'attempts', options.scenario, 'source')
  if (inside(baseline, candidate) || inside(candidate, baseline)) throw new Error('Candidate must not be the frozen attempt source')
  const candidateInfo = verifyCandidateSource(candidate, baseline)
  const output = path.join(manifest.root, 'evaluation', 'candidates', options.campaign?.evaluationId ?? `${options.scenario}-${candidateInfo.digest.slice(0, 16)}`)
  if (fs.existsSync(output)) throw new Error(`Candidate evaluation already exists: ${output}`)
  const playwrightModules = fs.realpathSync(options.playwrightNodeModules)
  if (!fs.existsSync(path.join(playwrightModules, '@playwright/test/cli.js'))) throw new Error('Playwright runtime is missing')
  const cache = fs.realpathSync(options.yarnCacheFolder)
  const work = path.join(output, 'work')
  const privateDir = path.join(output, 'private')
  const protectedFiles = [path.join(manifest.fixtureRoot, 'manifest.json'),
    path.join(manifest.sourceCheckout, 'package.json'), path.join(manifest.root, 'repository-study.json')]
  const protectedBefore = protectedFiles.map((file) => sha(fs.readFileSync(file)))
  const receipt: CandidateReceipt = {
    schemaVersion: 2, scenario: options.scenario, candidateDigest: candidateInfo.digest,
    changedSourceFiles: candidateInfo.changedSourceFiles, status: 'invalid', code: null,
    roster: [], passed: [], failed: [], skipped: [], containerImage: candidateImage,
    containerState: path.relative(manifest.root, path.join(privateDir, 'container-state.json')),
    containerRecovery: path.relative(manifest.root, path.join(privateDir, 'container-recovery.json')),
    evidence: path.relative(manifest.root, path.join(privateDir, 'playwright.json')),
  }
  fs.mkdirSync(privateDir, { recursive: true })
  let oracleDigest = ''
  let containers: CandidateContainers | undefined
  let relay: { close: () => Promise<void> } | undefined
  const interruption = new AbortController()
  const abort = (): void => interruption.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    const source = path.join(work, 'source')
    const host = path.join(work, 'host')
    for (const name of Object.keys(sourceFiles(candidate))) {
      const target = path.join(source, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(candidate, name), target)
    }
    if (sha(JSON.stringify(sourceFiles(source))) !== candidateInfo.digest) throw new Error('Candidate changed during staging')
    copy(path.join(manifest.root, 'frozen/fixture/host'), host)
    copy(path.join(manifest.root, 'frozen/fixture/package-stub'), path.join(work, 'package-stub'))
    copy(path.join(manifest.root, 'frozen/fixture/oracle'), path.join(privateDir, 'suite'))
    oracleDigest = sha(JSON.stringify(sourceFiles(path.join(privateDir, 'suite'))))
    fs.symlinkSync(playwrightModules, path.join(privateDir, 'node_modules'), 'dir')
    containers = new CandidateContainers(output, cache, interruption.signal)
    await containers.verifyRuntime()
    await containers.createVolume()
    const buildId = await containers.create('build')
    await containers.copyIn(`${source}/.`, buildId, '/source/')
    await containers.initCache(buildId)
    await verifyContainerSource(containers, buildId, sourceFiles(source))
    await containers.exec(buildId, ['yarn', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
      path.join(privateDir, 'source-install.log'), 180_000, '/source')
    await containers.exec(buildId, ['yarn', 'build'], path.join(privateDir, 'source-build.log'), 180_000, '/source')
    await verifyContainerSource(containers, buildId, sourceFiles(source))
    await containers.stop(buildId)
    await containers.remove(buildId)
    const hostId = await containers.create('host')
    await containers.exec(hostId, ['mkdir', '-p', '/host', '/package-stub'])
    await containers.copyIn(`${host}/.`, hostId, '/host/')
    await containers.copyIn(`${path.join(work, 'package-stub')}/.`, hostId, '/package-stub/')
    await containers.initCache(hostId)
    await containers.exec(hostId, ['yarn', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
      path.join(privateDir, 'host-install.log'), 180_000, '/host')
    const setup = `const fs=require('fs');const link=${JSON.stringify(`/host/node_modules/${subjectPackageName(source)}`)};fs.rmSync(link,{recursive:true,force:true});fs.symlinkSync('/source',link,'dir');fs.copyFileSync('/host/fixture.env','/host/.env.local');fs.mkdirSync('/host/.next',{recursive:true});fs.mkdirSync('/host/.mcp-next/generated',{recursive:true});fs.writeFileSync('/host/next-env.d.ts','')`
    await containers.exec(hostId, ['node', '-e', setup])
    await containers.exec(hostId, ['chmod', '-R', 'a+rwX', '/host/.next', '/host/.mcp-next/generated'])
    await containers.exec(hostId, ['chmod', 'a+rw', '/host/next-env.d.ts'])
    await verifyContainerSource(containers, hostId, sourceFiles(source))
    fs.mkdirSync(path.join(privateDir, 'home'), { recursive: true })
    fs.mkdirSync(path.join(privateDir, 'tmp'), { recursive: true })
    await containers.checked(['exec', '-d', '-u', 'node', '-e', 'HOME=/tmp', '-w', '/host', hostId, 'sh', '-c',
      'node /host/node_modules/next/dist/bin/next dev -p 3411 -H 127.0.0.1 > /tmp/host.log 2>&1'])
    relay = await containers.startRelay(hostId, path.join(privateDir, 'relay.log'))
    await waitForContainerHost(interruption.signal)
    const { report, evidence } = await runRepositoryOracle(privateDir, playwrightModules,
      { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(privateDir, 'home'),
        TMPDIR: path.join(privateDir, 'tmp'), CI: '1' }, false)
    receipt.code = evidence.code
    receipt.roster = evidence.roster
    receipt.passed = evidence.passed
    receipt.failed = evidence.failed
    receipt.skipped = evidence.skipped
    receipt.status = assertCandidateOracle(report, evidence)
    await verifyContainerSource(containers, hostId, sourceFiles(source))
    fs.writeFileSync(path.join(privateDir, 'host.log'), await containers.exec(hostId,
      ['head', '-c', '1048576', '/tmp/host.log'], undefined, 10_000))
  } catch (error) {
    receipt.status = 'invalid'
    receipt.error = String(error)
  }
  const cleanupErrors: string[] = []
  try { if (relay) await relay.close() } catch (error) { cleanupErrors.push(String(error)) }
  try { if (containers) await containers.cleanup() } catch (error) { cleanupErrors.push(String(error)) }
  if (cleanupErrors.length) {
    receipt.status = 'invalid'
    receipt.error = `Candidate cleanup failed: ${cleanupErrors.join('; ')}`
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
  options.signal?.removeEventListener('abort', abort)
  try {
    if (oracleDigest && sha(JSON.stringify(sourceFiles(path.join(privateDir, 'suite')))) !== oracleDigest ||
        protectedFiles.some((file, index) => sha(fs.readFileSync(file)) !== protectedBefore[index])) {
      throw new Error('Protected candidate evaluation inputs changed')
    }
    loadRepositoryStudy(manifest.root)
  } catch (error) {
    receipt.status = 'invalid'
    receipt.error = String(error)
  }
  json(path.join(privateDir, 'verdict.json'), receipt)
  if (receipt.status === 'invalid') throw new Error(`Candidate evaluation invalid: ${receipt.error}; see ${privateDir}`)
  return receipt
}
