import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startProxyShim, type ProxyShim, type ProxyShimEvent } from '../../apps/web-server/src/features/runs/logic/runtime/perturbation/proxy-shim'
import type { RobustnessEnvelope } from '../../shared/robustness/types'
import { repairSteps } from '../storefront-repairs.mjs'

// The trials fixture: the shipped storefront suite run against the shipped
// storefront services, through the SAME proxy shim a perturbed run boots — but
// without the run loop around it. What is reused is what the gate is about: the
// shim, the envelope, the suite and the services. What is replaced is glue the
// gate is not about: the per-run worktree becomes a copied directory, the PTY
// becomes a child process, `CANARY_PORT_<slot>` is set by hand. The suite files
// stay byte-identical to the template; only a tsconfig beside them maps the
// `canary-lab/feature-support/*` imports onto this checkout's sources instead
// of an installed package.

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE_APP = path.join(REPO, 'templates', 'project', 'demo-app')
const TEMPLATE_SUITE = path.join(REPO, 'templates', 'project', 'features', 'storefront-journey')
const DEFECTS_DIR = path.join(REPO, 'tools', 'robustness-trials', 'defects')
const TSX_LOADER = path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')

export const SLOTS = ['catalog', 'inventory', 'checkout'] as const
export type Slot = (typeof SLOTS)[number]

export const DEFECTS = ['duplicate-unkeyed', 'restart-in-memory', 'latency-timeout'] as const
export type DefectName = (typeof DEFECTS)[number]

export interface Workdir {
  root: string
  suiteDir: string
  greenApp: string
  stateRoot: string
  reportsRoot: string
}

/** Lays the fixture out under `root` (wiped first): the suite, the GREEN app
 *  (template + all ten scripted repairs), and scratch space for trial state. */
export function prepareWorkdir(root: string): Workdir {
  fs.rmSync(root, { recursive: true, force: true })
  const suiteDir = path.join(root, 'suite')
  const greenApp = path.join(root, 'app-green')
  const stateRoot = path.join(root, 'state')
  const reportsRoot = path.join(root, 'reports')
  fs.mkdirSync(stateRoot, { recursive: true })
  fs.mkdirSync(reportsRoot, { recursive: true })

  fs.cpSync(TEMPLATE_SUITE, suiteDir, { recursive: true })
  fs.writeFileSync(path.join(suiteDir, 'package.json'), JSON.stringify({ name: 'robustness-trials-suite', private: true }, null, 2))
  fs.writeFileSync(path.join(suiteDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: {
        'canary-lab/feature-support/log-marker-fixture': [path.join(REPO, 'shared', 'e2e-runner', 'log-marker-fixture.ts')],
        'canary-lab/feature-support/playwright-base': [path.join(REPO, 'shared', 'configs', 'playwright.base.ts')],
      },
    },
  }, null, 2))
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(suiteDir, 'node_modules'), 'dir')

  fs.cpSync(TEMPLATE_APP, greenApp, { recursive: true })
  for (const step of repairSteps) step.apply(greenApp)
  return { root, suiteDir, greenApp, stateRoot, reportsRoot }
}

/** A copy of the green app with one seeded defect patched in. */
export function seededApp(work: Workdir, defect: DefectName): string {
  const dir = path.join(work.root, `app-${defect}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(work.greenApp, dir, { recursive: true })
  const patch = fs.readFileSync(path.join(DEFECTS_DIR, `${defect}.patch`))
  const result = spawnSync('patch', ['-p1', '-s', '-d', dir], { input: patch, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`seeded defect ${defect} no longer applies to the green app: ${result.stdout}${result.stderr}`)
  return dir
}

export interface Failure {
  title: string
  error: string
}

export interface TrialResult {
  label: string
  failures: Failure[]
  /** Titles of every test the report listed, in execution order. */
  tests: string[]
  events: ProxyShimEvent[]
  durationMs: number
  /** Set when Playwright produced no report at all — a harness failure, never a finding. */
  inconclusive?: string
}

interface Service {
  slot: Slot
  port: number
  restart: () => Promise<void>
  stop: () => Promise<void>
}

/** One trial: fresh state, three services, one shim per slot when an envelope
 *  is given, one Playwright pass through the shims, everything torn down. */
export async function runTrial(work: Workdir, appDir: string, envelope: RobustnessEnvelope | undefined, label: string): Promise<TrialResult> {
  const started = Date.now()
  const stateDir = fs.mkdtempSync(path.join(work.stateRoot, `${label}-`))
  const services = await Promise.all(SLOTS.map((slot) => bootService(appDir, stateDir, slot)))
  const shims: ProxyShim[] = []
  const events: ProxyShimEvent[] = []
  try {
    if (envelope) {
      for (const svc of services) {
        const restart = envelope.restart?.find((r) => r.slot === svc.slot)
        shims.push(await startProxyShim({
          slot: svc.slot,
          upstreamPort: svc.port,
          listenPort: 0,
          latency: envelope.latency,
          duplicate: envelope.duplicate,
          ...(restart ? { restart: { afterNth: restart.afterNth, match: restart.match, perform: svc.restart } } : {}),
          onEvent: (event) => events.push(event),
        }))
      }
    }
    const clientPort = (slot: Slot) => shims.find((s) => s.slot === slot)?.port ?? services.find((s) => s.slot === slot)!.port
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', CANARY_LAB_MANIFEST_PATH: path.join(stateDir, 'no-manifest.json') }
    for (const slot of SLOTS) env[`CANARY_PORT_${slot}`] = String(clientPort(slot))
    // Async, never `spawnSync`: the shims live on THIS event loop, and a
    // blocking wait would leave every request through them unanswered.
    const result = await runPlaywright(work.suiteDir, env, path.join(stateDir, 'test-results'))
    fs.writeFileSync(path.join(work.reportsRoot, `${label}.json`), result.stdout)
    const parsed = parseReport(result.stdout)
    if (!parsed) {
      return { label, failures: [], tests: [], events, durationMs: Date.now() - started, inconclusive: `playwright exited ${result.status} without a report: ${result.stderr.slice(0, 2000)}` }
    }
    return { label, ...parsed, events, durationMs: Date.now() - started }
  } finally {
    await Promise.all(shims.map((s) => s.close()))
    await Promise.all(services.map((s) => s.stop()))
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

interface PlaywrightExit { status: number | null; stdout: string; stderr: string }

function runPlaywright(cwd: string, env: NodeJS.ProcessEnv, outputDir: string): Promise<PlaywrightExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO, 'node_modules', '.bin', 'playwright'), ['test', '--reporter=json', '--max-failures=0', '--output', outputDir], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
    child.once('error', reject)
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

interface ReportSpec { title: string; ok: boolean; tests: { results: { status: string; error?: { message?: string } }[] }[] }
interface ReportSuite { specs?: ReportSpec[]; suites?: ReportSuite[] }

function parseReport(stdout: string): Pick<TrialResult, 'failures' | 'tests'> | undefined {
  const start = stdout.indexOf('{')
  if (start < 0) return undefined
  let report: { suites?: ReportSuite[] }
  try {
    report = JSON.parse(stdout.slice(start))
  } catch {
    return undefined
  }
  const specs: ReportSpec[] = []
  const walk = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) specs.push(spec)
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return {
    tests: specs.map((s) => s.title),
    failures: specs.filter((s) => !s.ok).map((s) => ({
      title: s.title,
      error: firstLine(s.tests.flatMap((t) => t.results).find((r) => r.error?.message)?.error?.message ?? 'no error message'),
    })),
  }
}

function firstLine(message: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI colour codes from Playwright's error rendering
  return message.replace(/\[[0-9;]*m/g, '').split('\n').find((line) => line.trim())?.trim() ?? message
}

async function bootService(appDir: string, stateDir: string, slot: Slot): Promise<Service> {
  const port = await freePort()
  const log = fs.openSync(path.join(stateDir, `${slot}.log`), 'a')
  let child: ChildProcess | undefined
  const start = async () => {
    // `node --import <tsx loader>` runs the service in ONE process, so a SIGTERM
    // reaches the listener itself — no npm/npx wrapper left holding the port.
    // The loader is named by absolute path: the app copy has no node_modules.
    child = spawn(process.execPath, ['--import', TSX_LOADER, path.join(appDir, `${slot}-service`, 'server.ts')], {
      cwd: appDir,
      env: { ...process.env, PORT: String(port), STOREFRONT_STATE_DIR: path.join(stateDir, slot), LOG_MODE: 'plain' },
      stdio: ['ignore', log, log],
    })
    await waitForHttp(port, 20_000, slot)
  }
  const stop = async () => {
    const proc = child
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => proc.kill('SIGKILL'), 2000)
      proc.once('exit', () => { clearTimeout(killer); resolve() })
      proc.kill('SIGTERM')
    })
  }
  await start()
  return {
    slot,
    port,
    stop,
    restart: async () => { await stop(); await start() },
  }
}

async function waitForHttp(port: number, timeoutMs: number, slot: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`${slot} service did not answer on :${port} within ${timeoutMs} ms`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}
