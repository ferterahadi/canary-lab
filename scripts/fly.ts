import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { banner, section, ok, fail, info, dim, line } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'
import { isCanaryLabWorkspace } from '../shared/runtime/project-root'
import {
  DEFAULT_PORT,
  loadProjectConfig,
  resolveProjectPort,
} from '../apps/web-server/src/features/runs/logic/runtime/launcher/project-config'
import { relaunchUiDetached } from './ui-command'
import { main as initProject } from './init-project'
import {
  isActiveFlightStatus,
  type FlightCheckpoint,
  type FlightCheckpointResponse,
  type FlightIndexEntry,
  type FlightManifest,
  type FlightStageStatus,
} from '../shared/flights/types'

// `canary-lab fly <repo...> "<what to test>"` — the one-command entry that
// takes a bare product repo to a green, covered, healed run ending in an
// evaluation export. This command is a thin client: it locates (or inits) the
// workspace, makes sure the UI server is up, starts/resumes the flight over
// the same REST surface the web UI uses, then streams stage progress to the
// terminal and answers checkpoints interactively. The conductor — and every
// stage verdict — lives server-side.

export interface FlyArgs {
  repoPaths: string[]
  description: string
  feature?: string
  env: string
  coverageTarget: number
  base?: string
  yolo: boolean
  fresh: boolean
}

export type FlyParseResult = { ok: true; args: FlyArgs } | { ok: false; error: string }

function defaultIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function parseFlyArgs(argv: string[], isDir: (p: string) => boolean = defaultIsDir): FlyParseResult {
  const positionals: string[] = []
  let feature: string | undefined
  let env = 'local'
  let coverageTarget = 100
  let base: string | undefined
  let yolo = false
  let fresh = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yolo') { yolo = true; continue }
    if (arg === '--fresh') { fresh = true; continue }
    if (arg === '--feature' || arg === '--env' || arg === '--base' || arg === '--coverage-target') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `Missing value for ${arg}` }
      i += 1
      if (arg === '--feature') feature = value
      else if (arg === '--env') env = value
      else if (arg === '--base') base = value
      else {
        const pct = Number(value)
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return { ok: false, error: `Invalid --coverage-target: ${value} (expected 0–100)` }
        }
        coverageTarget = pct
      }
      continue
    }
    if (arg.startsWith('--')) return { ok: false, error: `Unknown flag: ${arg}` }
    positionals.push(arg)
  }

  if (positionals.length < 2) {
    return { ok: false, error: 'Usage: canary-lab fly <repo-path...> "<what to test>" — needs at least one repo path and a description' }
  }
  const description = positionals[positionals.length - 1]
  const repos = positionals.slice(0, -1)
  if (isDir(description)) {
    return { ok: false, error: `Missing description: the last argument must be the "<what to test>" text, but ${description} is a directory` }
  }
  for (const repo of repos) {
    if (!isDir(repo)) return { ok: false, error: `Repo path not found: ${repo}` }
  }

  return {
    ok: true,
    args: {
      repoPaths: repos.map((r) => path.resolve(r)),
      description,
      ...(feature ? { feature } : {}),
      env,
      coverageTarget,
      ...(base ? { base } : {}),
      yolo,
      fresh,
    },
  }
}

/** Feature name when `--feature` is absent: a slug of the first repo's basename. */
export function deriveFeatureName(repoPaths: string[], explicit?: string): string {
  if (explicit) return explicit
  const baseName = path.basename(repoPaths[0])
  const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'first-flight'
}

/** Nearest enclosing Canary Lab workspace (init's dependency marker — a bare
 *  `features/` dir is NOT enough; a product repo may legitimately have one). */
export function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  for (;;) {
    if (isCanaryLabWorkspace(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function serverBase(workspaceRoot: string): string {
  try {
    return `http://localhost:${resolveProjectPort(loadProjectConfig(workspaceRoot))}`
  } catch {
    return `http://localhost:${DEFAULT_PORT}`
  }
}

async function serverIsUp(base: string): Promise<boolean> {
  try {
    const resp = await fetch(`${base}/mcp/health`, { signal: AbortSignal.timeout(2000) })
    return resp.ok
  } catch {
    return false
  }
}

async function ensureServer(workspaceRoot: string, base: string): Promise<void> {
  if (await serverIsUp(base)) return
  info(`Starting the Canary Lab server for ${dim(workspaceRoot)}…`)
  relaunchUiDetached(workspaceRoot)
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await serverIsUp(base)) return
  }
  fail(`The Canary Lab server did not come up at ${base}. Start it manually with \`npx canary-lab ui\` and retry.`)
  process.exit(1)
}

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let resp: Response
  try {
    resp = await fetch(url, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    })
  } catch {
    fail(`Lost the Canary Lab server mid-flight (${url}). Restart it with \`npx canary-lab ui\`, then \`fly\` again — the flight resumes where it stopped.`)
    process.exit(1)
  }
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  return { status: resp.status, json }
}

function latestForRepos(flights: FlightIndexEntry[], repoPaths: string[]): FlightIndexEntry | null {
  const targets = new Set(repoPaths.map((p) => path.resolve(p)))
  // /api/flights lists newest-first.
  return flights.find((f) => (f.repoPaths ?? []).some((p) => targets.has(path.resolve(p)))) ?? null
}

const STAGE_ICON: Record<FlightStageStatus, string> = {
  'pending': '·',
  'running': '▸',
  'waiting-for-approval': '?',
  'done': '✔',
  'failed': '✖',
  'skipped': '↷',
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/** Turn a parked checkpoint into a response by prompting the terminal. */
async function promptCheckpoint(checkpoint: FlightCheckpoint): Promise<FlightCheckpointResponse> {
  line()
  section(`Checkpoint — ${checkpoint.kind}`)
  info(checkpoint.message)
  if (checkpoint.kind === 'missing-env') {
    const missing = Array.isArray((checkpoint.data as { missing?: string[] } | undefined)?.missing)
      ? ((checkpoint.data as { missing: string[] }).missing)
      : []
    const values: Record<string, string> = {}
    for (const key of missing) {
      values[key] = await ask(`  ${key} = `)
    }
    return { values }
  }
  if (checkpoint.options && checkpoint.options.length > 0) {
    checkpoint.options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`))
    for (;;) {
      const answer = await ask(`Choose [1-${checkpoint.options.length}]: `)
      const byNumber = checkpoint.options[Number(answer) - 1]
      const byName = checkpoint.options.find((o) => o === answer)
      const choice = byName ?? byNumber
      if (choice) return { choice }
    }
  }
  const answer = await ask('Approve? [y/N] ')
  return { choice: /^y(es)?$/i.test(answer) ? 'approve' : 'reject' }
}

function verdictExitCode(m: FlightManifest): number {
  if (m.status === 'done') return m.runVerdict === 'passed' || m.runVerdict === undefined ? 0 : 1
  if (m.status === 'paused') return 2
  return 3
}

/** Poll the flight and mirror stage transitions to the terminal until it
 *  settles. Checkpoints prompt inline (TTY) or park with exit code 2. */
async function watchFlight(base: string, flightId: string): Promise<number> {
  const printed = new Map<string, FlightStageStatus>()
  for (;;) {
    const { status, json } = await requestJson('GET', `${base}/api/flights/${encodeURIComponent(flightId)}`)
    if (status !== 200) {
      fail(`Flight ${flightId} disappeared (${status}): ${String(json.error ?? '')}`)
      return 3
    }
    const manifest = json as unknown as FlightManifest

    for (const stage of manifest.stages) {
      const prev = printed.get(stage.key)
      if (prev === stage.status) continue
      printed.set(stage.key, stage.status)
      if (stage.status === 'pending') continue
      const icon = STAGE_ICON[stage.status]
      const suffix =
        stage.status === 'failed' && stage.error ? ` — ${stage.error}`
        : stage.status === 'skipped' && stage.skipReason ? ` ${dim(`(${stage.skipReason})`)}`
        : ''
      console.log(`  ${icon} ${stage.key}${stage.status === 'running' ? dim(' …') : ''}${suffix}`)
    }

    if (manifest.status === 'waiting-for-approval') {
      const stage = manifest.stages.find((s) => s.status === 'waiting-for-approval')
      if (stage?.checkpoint) {
        if (!process.stdin.isTTY) {
          info(`Waiting for approval: ${stage.checkpoint.message}`)
          info(`Answer from the web UI at ${dim(base)} (or \`fly\` again from a terminal).`)
          return 2
        }
        const response = await promptCheckpoint(stage.checkpoint)
        const posted = await requestJson('POST', `${base}/api/flights/${encodeURIComponent(flightId)}/respond`, { response })
        if (posted.status !== 200) fail(`Checkpoint response rejected (${posted.status}): ${String(posted.json.error ?? '')}`)
        // Reprint the stage's next transition.
        printed.delete(stage.key)
        continue
      }
    }

    if (manifest.status === 'done' || manifest.status === 'failed' || manifest.status === 'aborted' || manifest.status === 'paused') {
      line()
      if (manifest.status === 'done') {
        ok(`Flight ${flightId} complete — run ${manifest.runVerdict ?? 'n/a'}.`)
        if (manifest.links?.evaluationZip) info(`Evaluation archive: ${dim(manifest.links.evaluationZip)}`)
      } else if (manifest.status === 'paused') {
        fail(`Flight ${flightId} paused: ${manifest.error ?? 'a stage failed'}.`)
        info('Fix the cause if needed, then `canary-lab fly` the same repo again to resume from the failed stage (`--fresh` starts over).')
      } else {
        fail(`Flight ${flightId} ${manifest.status}${manifest.error ? `: ${manifest.error}` : ''}.`)
      }
      return verdictExitCode(manifest)
    }

    await new Promise((r) => setTimeout(r, 1000))
  }
}

function usage(): void {
  banner('Canary Lab — fly')
  section('Usage')
  console.log(`  canary-lab fly <repo-path...> "<what to test>" ${dim('[--feature <name>] [--env <envset>]')}`)
  console.log(`                 ${dim('[--coverage-target <pct>] [--base <branch>] [--yolo] [--fresh]')}`)
  line()
  info('One command: repo → scaffold → env → PRD → specs↔coverage → portify → run → heal → evaluation export.')
  info('Re-running `fly` resumes an interrupted flight; `--fresh` starts over; `--yolo` skips all checkpoints except missing secrets.')
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    usage()
    return
  }
  const parsed = parseFlyArgs(args)
  if (!parsed.ok) {
    fail(parsed.error)
    usage()
    process.exit(1)
    return
  }
  const fly = parsed.args
  const feature = deriveFeatureName(fly.repoPaths, fly.feature)

  banner('Canary Lab — first flight')

  // Locate or create the workspace, then make sure its server is up.
  let workspaceRoot = findWorkspaceRoot(process.cwd())
  if (!workspaceRoot) {
    workspaceRoot = path.join(process.cwd(), 'canary-lab')
    info(`No Canary Lab workspace found — creating one at ${dim(workspaceRoot)}.`)
    await initProject([workspaceRoot])
  }
  const base = serverBase(workspaceRoot)
  await ensureServer(workspaceRoot, base)

  // Resume-or-start: an interrupted flight for the same repo set picks up from
  // its first open stage; `--fresh` always starts a new flight (the server
  // still 409s while one is genuinely active).
  const listed = await requestJson('GET', `${base}/api/flights`)
  const latest = latestForRepos(((listed.json.flights ?? []) as FlightIndexEntry[]), fly.repoPaths)

  let flightId: string
  if (latest && isActiveFlightStatus(latest.status)) {
    info(`Flight ${dim(latest.flightId)} is already active for this repo — attaching.`)
    flightId = latest.flightId
  } else if (latest && latest.status === 'paused' && !fly.fresh) {
    info(`Resuming flight ${dim(latest.flightId)} from stage ${dim(String(latest.currentStage ?? '?'))}.`)
    const resumed = await requestJson('POST', `${base}/api/flights/${encodeURIComponent(latest.flightId)}/resume`)
    if (resumed.status !== 200) {
      fail(`Resume failed (${resumed.status}): ${String(resumed.json.error ?? '')}`)
      process.exit(1)
    }
    flightId = latest.flightId
  } else {
    const started = await requestJson('POST', `${base}/api/flights`, {
      feature,
      repoPaths: fly.repoPaths,
      description: fly.description,
      env: fly.env,
      coverageTarget: fly.coverageTarget,
      ...(fly.base ? { base: fly.base } : {}),
      yolo: fly.yolo,
    })
    if (started.status === 409 && started.json.type === 'flight_conflict') {
      info(`A flight is already active for this repo — attaching to ${dim(String(started.json.existingFlightId))}.`)
      flightId = String(started.json.existingFlightId)
    } else if (started.status !== 201) {
      fail(`Could not start the flight (${started.status}): ${String(started.json.error ?? '')}`)
      process.exit(1)
      return
    } else {
      flightId = String((started.json as { flightId?: string }).flightId)
      ok(`Flight ${dim(flightId)} started for ${dim(fly.repoPaths.join(', '))} → feature "${feature}".`)
      info(`Watch it live in the web UI: ${dim(base)}`)
    }
  }

  line()
  const code = await watchFlight(base, flightId)
  process.exit(code)
}

runAsScript(module, () => main())
