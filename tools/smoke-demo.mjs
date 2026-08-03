import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

// A smoke test you can WATCH. `smoke:pack` proves the tarball scaffolds; this
// proves the product actually repairs something, by driving one full loop
// against a throwaway workspace and then leaving the UI open on the result:
//
//   scaffold → git init → boot UI → run demo_catalog → tests fail
//   → park for repair → fix the app IN THE RUN'S WORKING COPY → signal a rerun
//   → tests pass → diff captured → pull request attempted → Changes tab
//
// The repair step is played by this script with a canned patch instead of an
// agent, on purpose: a smoke test that needs an LLM is not a smoke test. What
// it exercises is the machinery around the repair — worktree isolation, the
// signal loop, the capture at teardown, the PR attempt and its recorded
// reason — which is exactly the part that can silently break.
//
// The throwaway project is deliberately NOT a GitHub repo, so the pull-request
// step lands on its "no origin" path. That is the safe outcome to exercise
// automatically: a smoke test must never push a branch anywhere.
//
//   node tools/smoke-demo.mjs [--no-build] [--keep-open] [--port <n>]

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const noBuild = argv.includes('--no-build')
const keepOpen = argv.includes('--keep-open')
const portArg = argv.indexOf('--port')
const FEATURE = 'demo_catalog'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lab-demo-'))
const projectDir = path.join(tempRoot, 'demo-project')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

const childEnv = {
  ...process.env,
  npm_config_cache: cacheDir,
  // Keep the registry + active-server records inside the throwaway dir so this
  // never disturbs a real `canary-lab ui` the developer has running.
  CANARY_LAB_HOME: tempRoot,
  CANARY_LAB_AGENT_HOME: tempRoot,
  CANARY_LAB_SKIP_CLIENT_MCP: '1',
}

let step = 0
function say(message) {
  step += 1
  console.log(`\n[${step}] ${message}`)
}

function run(command, args, cwd, opts = {}) {
  const result = spawnSync(command, args, { cwd, stdio: opts.quiet ? 'pipe' : 'inherit', env: childEnv })
  if (result.status !== 0 && !opts.allowFailure) {
    console.error(result.stderr?.toString() ?? '')
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  }
  return result
}

/** Ask the OS for a free port. `listen(0)` is async — reading `.address()`
 *  before the listening callback returns null, so this has to await it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(port, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (res.status >= 400) throw new Error(`${method} ${route} → ${res.status}: ${text}`)
  return json
}

/** Poll `check` until it returns a value, or give up with a readable error. */
async function until(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await delay(1000)
  }
  throw new Error(`timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s`)
}

// The three planted bugs in the sample's server, and the repair an agent would
// make: honour `price` on PATCH, actually remove the product on DELETE, and
// hand out ids from a counter rather than from the catalog's size — the third
// only starts failing once the second is fixed, which is what makes a real
// repair take more than one pass. Kept as literal replacements so a drift in
// the sample fails loudly here rather than silently "repairing" nothing.
const REPAIRS = [
  {
    find: `      if (patch.name !== undefined) product.name = patch.name\n      res.end(JSON.stringify(product))`,
    replace: `      if (patch.name !== undefined) product.name = patch.name\n      if (typeof patch.price === 'number') product.price = patch.price\n      res.end(JSON.stringify(product))`,
  },
  {
    find: `      res.writeHead(405)\n      res.end(JSON.stringify({ error: 'delete is not supported' }))\n      return`,
    replace: `      const [, , id] = url.pathname.split('/')\n      const index = products.findIndex((entry) => entry.id === id)\n      if (index < 0) {\n        res.writeHead(404)\n        res.end(JSON.stringify({ error: 'not found' }))\n        return\n      }\n      products.splice(index, 1)\n      res.writeHead(204)\n      res.end()\n      return`,
  },
  {
    find: `const nextProductId = () => String(products.length + 1)`,
    replace: `let issuedIds = 0\nconst nextProductId = () => String(++issuedIds)`,
  },
]

function repairServer(serverPath) {
  let source = fs.readFileSync(serverPath, 'utf-8')
  for (const [i, repair] of REPAIRS.entries()) {
    if (!source.includes(repair.find)) {
      throw new Error(`repair ${i + 1} no longer matches ${serverPath} — the sample drifted, update tools/smoke-demo.mjs`)
    }
    source = source.replace(repair.find, repair.replace)
  }
  fs.writeFileSync(serverPath, source)
}

let uiChild = null

async function main() {
  say(`Scaffolding a throwaway workspace in ${projectDir}`)
  let tarballPath
  if (noBuild) {
    const existing = fs.readdirSync(repoRoot).find((entry) => entry.endsWith('.tgz'))
    if (!existing) throw new Error('--no-build needs a packed .tgz in the repo root')
    tarballPath = path.join(repoRoot, existing)
  } else {
    run('npm', ['run', 'build'], repoRoot)
    run('npm', ['pack', '--pack-destination', tempRoot], repoRoot)
    tarballPath = path.join(tempRoot, fs.readdirSync(tempRoot).find((entry) => entry.endsWith('.tgz')))
  }
  run('npm', ['init', '-y'], tempRoot, { quiet: true })
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `file:${tarballPath}`], tempRoot)
  run('npx', ['canary-lab', 'init', 'demo-project', '--package-spec', `file:${tarballPath}`, '--no-install'], tempRoot)
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir)

  // Worktree isolation needs a git repo with a commit to cut from — without one
  // every run falls back to running in place and nothing is captured. `init`
  // already runs `git init`, so this only has to make the baseline commit.
  say('Committing a git baseline — worktree isolation (and the captured diff) needs one')
  if (!fs.existsSync(path.join(projectDir, '.git'))) run('git', ['init', '-q'], projectDir)
  run('git', ['add', '-A'], projectDir)
  run('git', ['-c', 'user.email=smoke@canary-lab.local', '-c', 'user.name=Canary Smoke', 'commit', '-qm', 'demo baseline'], projectDir)

  const port = portArg >= 0 ? Number(argv[portArg + 1]) : await freePort()
  const configPath = path.join(projectDir, 'canary-lab.config.json')
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {}
  fs.writeFileSync(configPath, JSON.stringify({ ...config, port, healAgent: 'external' }, null, 2) + '\n')

  say(`Booting the UI on http://127.0.0.1:${port}`)
  uiChild = spawn('npx', ['canary-lab', 'ui', '--no-open'], { cwd: projectDir, env: childEnv, stdio: 'inherit' })
  await until('the server to answer', 90_000, async () => {
    try {
      const health = await api(port, 'GET', '/mcp/health')
      return health?.ok ? health : null
    } catch {
      return null
    }
  })

  say(`Starting a run of ${FEATURE} — its API ignores the price on PATCH and refuses DELETE, so tests must fail`)
  const started = await api(port, 'POST', '/api/runs', { feature: FEATURE, env: 'local' })
  const runId = started.runId ?? started.run?.runId
  if (!runId) throw new Error(`no runId in start response: ${JSON.stringify(started)}`)
  console.log(`    run ${runId}`)

  const failed = await until('the run to fail and park for repair', 240_000, async () => {
    const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
    const status = detail.manifest.status
    const failures = detail.summary?.failed?.length ?? 0
    if (status === 'healing' && failures > 0) return detail
    if (status === 'failed' || status === 'aborted') return detail
    return null
  })
  const failedNames = (failed.summary?.failed ?? []).map((f) => f.name)
  console.log(`    ${failedNames.length} failing: ${failedNames.join(' · ') || '(none reported)'}`)
  if (failedNames.length === 0) throw new Error('the broken sample passed — it is no longer a repair demo')

  // `worktrees` is keyed by REPO name, not by feature name — one run can
  // isolate several repos, and a feature's repo rarely shares its name (this
  // sample's feature is `demo_catalog`, its repo `catalog_service`). Every
  // entry belongs to this run, so probe them all.
  const worktrees = Object.values(failed.manifest.worktrees ?? {})
  if (worktrees.length === 0) throw new Error('no per-run worktree recorded — the run fell back to running in place')
  // The worktree is cut from the REPO root — the whole scaffolded project —
  // and the demo feature points OUTWARD at product code beside `features/`,
  // so the service sits under demo-app/. The older layout (a self-contained
  // feature carrying its own scripts/) is kept as a fallback so this still
  // works against a hand-made feature of that shape.
  const serverPath = worktrees
    .flatMap((worktree) => [
      path.join(worktree, 'demo-app', 'catalog-service', 'server.ts'),
      path.join(worktree, 'scripts', 'server.ts'),
      path.join(worktree, 'features', FEATURE, 'scripts', 'server.ts'),
    ])
    .find((candidate) => fs.existsSync(candidate))
  if (!serverPath) throw new Error(`could not find the demo service's server.ts under ${worktrees.join(', ')}`)
  say(`Playing the repair agent inside the run's own working copy\n    ${serverPath}`)
  repairServer(serverPath)

  say('Signalling a rerun, exactly as an external agent would')
  await api(port, 'POST', `/api/runs/${encodeURIComponent(runId)}/signal`, {
    kind: 'restart',
    body: {
      hypothesis: 'PATCH ignored the new price and DELETE refused outright, so a repriced product kept its old price and a discontinued one could never leave the catalog.',
      fixDescription: 'Apply price on PATCH; splice the product out and answer 204 on DELETE.',
    },
  })

  const settled = await until('the rerun to finish', 240_000, async () => {
    const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
    return ['passed', 'failed', 'aborted'].includes(detail.manifest.status) ? detail : null
  })

  // Teardown writes the diff, then the pull-request attempt, then the terminal
  // status — three separate manifest writes. Polling on status alone can win the
  // race with the last one by a millisecond, so give the attempt a short window
  // to appear before judging it missing.
  const m = settled.manifest.status === 'passed'
    ? await until('the teardown record to settle', 30_000, async () => {
        const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
        return detail.manifest.prAttempt ? detail.manifest : null
      }).catch(() => settled.manifest)
    : settled.manifest
  say(`Verdict: ${m.status.toUpperCase()} — ${m.healCycles} repair cycle(s)`)
  const capture = m.fixCapture?.repos ?? []
  console.log(`    captured diff: ${capture.length > 0 ? capture.map((r) => `${r.repoName} (${r.files} files)`).join(', ') : 'NONE'}`)
  for (const result of m.prAttempt?.results ?? []) {
    console.log(`    pull request · ${result.repoName}: ${result.ok ? result.url : `none — ${result.reason}`}`)
  }

  const problems = []
  if (m.status !== 'passed') problems.push(`run ended ${m.status}, expected passed`)
  if (capture.length === 0) problems.push('no diff was captured from the repair')
  if (!m.prAttempt) problems.push('no pull-request attempt was recorded')

  // The URL is only worth printing with --keep-open: otherwise teardown removes
  // the whole workspace as this exits, and a link to a deleted run is worse
  // than no link.
  const url = `http://127.0.0.1:${port}/?feature=${encodeURIComponent(FEATURE)}&run=${encodeURIComponent(runId)}`
  const where = keepOpen ? `\n    Open the Changes tab: ${url}` : '\n    Re-run with --keep-open to browse the result in the UI.'
  if (problems.length > 0) {
    console.error(`\n✘ smoke:demo failed\n    - ${problems.join('\n    - ')}${where}`)
    process.exitCode = 1
  } else {
    console.log(`\n✔ smoke:demo passed — repaired, captured, and reported.${where}`)
  }

  if (keepOpen) {
    console.log('    (--keep-open: the UI stays up; Ctrl-C to stop and clean up)')
    await new Promise(() => {})
  }
}

function cleanup() {
  if (uiChild && !uiChild.killed) uiChild.kill('SIGTERM')
  // Never let teardown bury the real failure: the temp tree holds git worktrees
  // and a server that may still be releasing files, so removal can lose a race.
  if (keepOpen) return
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch (err) {
    console.warn(`    (could not remove ${tempRoot}: ${err.message})`)
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })

main()
  .catch((err) => {
    console.error(`\n✘ smoke:demo failed: ${err.message}`)
    process.exitCode = 1
  })
  .finally(cleanup)
