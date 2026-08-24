import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { renderInteractiveGuide } from './smoke-demo-output.mjs'
import { pruneDemoStateFromRealHome } from './demo-home-prune.mjs'
import { createDemoRoot } from './demo-workspace.mjs'

// The developer's `npx canary-lab init`.
//
// This script adds NOTHING to the workspace that `canary-lab init` does not
// already ship. It packs the current build, runs the real init, and opens the
// UI — so what a contributor sees is exactly what a user sees. If a
// demonstration is missing here, it is missing for users too; that is the
// signal this script exists to give.
//
// - `npm run demo` stops at the open UI and hands the tester both routes: run
//   the shipped storefront suite and watch a real agent repair three services,
//   or start a Flight. It never starts either one itself.
// - `npm run smoke:demo` drives the same shipped suite's ten repairs
//   deterministically. An LLM-free contributor gate, not the product tour.
//
// Deliberately NOT at parity with a user's `init`: workspace registration, the
// browser download, agent-skill install and MCP client registration are all
// suppressed below, because they write outside the isolated demo state. Those
// keep unit coverage; `smoke:pack` suppresses them for the same reason.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const interactive = argv.includes('--interactive')
const noBuild = argv.includes('--no-build')
const keepOpen = interactive || argv.includes('--keep-open')
const portArg = argv.indexOf('--port')
const agentArg = argv.indexOf('--agent')
const requestedAgent = agentArg >= 0 ? argv[agentArg + 1] : 'auto'
const featureName = 'storefront-journey'
const demoIntent = 'Test the library lending contracts. Borrowing an available book reduces its available copies by one. Returning an open loan marks it returned and restores the previous count. Borrowing when all copies are on loan returns 409 without changing inventory. A Wizard of Earthsea has one copy. Unknown-book and unknown-loan 404s are fixture support, not requirements.'

// Interactive demos are inspectable workspaces, so keep them somewhere visible
// and durable. The automated smoke journey remains disposable OS-temp state.
const demoRoot = createDemoRoot({ persistent: interactive })
const projectDir = path.join(demoRoot, 'demo-project')
const appDir = path.join(projectDir, 'demo-app')
const flightAppDir = path.join(projectDir, 'flight-app')
const workflowAppDir = path.join(projectDir, 'workflow-app')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

const childEnv = {
  ...process.env,
  npm_config_cache: cacheDir,
  // npm's lifecycle notices are implementation detail here. Interactive setup
  // captures every command and prints it on failure, while Canary Lab's own
  // server output remains visible after launch.
  ...(interactive ? { npm_config_loglevel: 'error' } : {}),
  // Demo state must never disturb another Canary Lab workspace or rewrite the
  // developer's real MCP client registrations.
  CANARY_LAB_HOME: demoRoot,
  CANARY_LAB_AGENT_HOME: demoRoot,
  CANARY_LAB_SKIP_CLIENT_MCP: '1',
  // The wrapper owns the demo terminal's Ctrl-C. The nested UI still performs
  // its full graceful shutdown, but must not open a competing stdin prompt.
  CANARY_LAB_PARENT_OWNS_SHUTDOWN: '1',
  // The scaffold's postinstall downloads the Playwright browser into the
  // developer's shared cache — outside the isolated workspace. Suppress it and
  // use whatever chromium the machine already has, which is what this script
  // has always done.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
}

let step = 0
let uiChild = null

function say(message) {
  step += 1
  console.log(`\n[${step}] ${message}`)
}

function progress(message) {
  if (interactive) console.log(`    › ${message}…`)
}

function complete(message) {
  if (interactive) console.log(`    ✓ ${message}`)
}

function commandText(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')
}

function printFailureOutput(command, args, result) {
  console.error(`\n    Command failed: ${commandText(command, args)}`)
  const stdout = result.stdout?.toString().trim()
  const stderr = result.stderr?.toString().trim()
  if (stdout) console.error(`\n${stdout}`)
  if (stderr) console.error(`\n${stderr}`)
  if (result.error) console.error(`\n${result.error.message}`)
}

function run(command, args, cwd, opts = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    env: childEnv,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0 && !opts.allowFailure) {
    if (opts.quiet) printFailureOutput(command, args, result)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  }
  return result
}

function setupTask(start, done, task) {
  progress(start)
  const result = task()
  complete(done)
  return result
}

function resolveAgent() {
  if (!['auto', 'claude', 'codex'].includes(requestedAgent)) {
    throw new Error('--agent must be one of: auto, claude, codex')
  }
  const candidates = requestedAgent === 'auto' ? ['claude', 'codex'] : [requestedAgent]
  const selected = candidates.find((agent) => spawnSync(agent, ['--version'], {
    env: childEnv,
    stdio: 'ignore',
  }).status === 0)
  if (!selected) {
    throw new Error(`npm run demo needs ${requestedAgent === 'auto' ? 'claude or codex' : requestedAgent} on PATH`)
  }
  return selected
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        server.close(() => reject(new Error('the OS did not allocate a TCP port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  const raw = await response.text()
  const parsed = raw ? JSON.parse(raw) : null
  if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${raw}`)
  return parsed
}

async function until(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(1000)
  }
  throw new Error(`timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s`)
}

function replaceOnce(filePath, find, replacement) {
  const source = fs.readFileSync(filePath, 'utf-8')
  if (!source.includes(find)) {
    throw new Error(`scripted repair no longer matches ${filePath} — the canonical demo drifted`)
  }
  fs.writeFileSync(filePath, source.replace(find, replacement))
}

// The ten defects, in the order the five journeys expose them. Each entry is
// the LLM-free stand-in for one heal cycle: wait for a cycle whose failures
// INCLUDE the one it names, patch exactly one application file, signal a rerun.
// Order is load-bearing — it is the contract order in demo-app/REQUIREMENTS.md.
//
// Deliberately one repair per cycle even though `healOnFailureThreshold: 4` now
// reports up to four failing journeys at once. A real agent may fix several per
// cycle; this gate fixes one so a failure here names a single defect instead of
// a batch, which is what keeps a timeout diagnosable.
const repairSteps = [
  {
    service: 'catalog-service',
    expectedFailure: 'espresso_beans',
    hypothesis: 'Catalog emits an underscore SKU, so inventory cannot consume the product identity contract.',
    fixDescription: 'Normalize whitespace in catalog SKUs to hyphens.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      ".replace(/\\s+/g, '_')",
      ".replace(/\\s+/g, '-')",
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 42',
    hypothesis: 'Inventory adds reservations to available stock instead of subtracting them.',
    fixDescription: 'Calculate available stock as on-hand minus reserved.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      'item.onHand + item.reserved',
      'item.onHand - item.reserved',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 3600',
    hypothesis: 'Checkout records the discount but still returns the undiscounted subtotal.',
    fixDescription: 'Apply discountPercent when calculating the cart total.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'const total = (cart: Cart): number => subtotal(cart)',
      'const total = (cart: Cart): number => Math.round(subtotal(cart) * (100 - cart.discountPercent) / 100)',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 1440',
    hypothesis: 'A second discount code is added to the first instead of replacing it.',
    fixDescription: 'Assign the new discount percentage rather than accumulating it.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'cart.discountPercent += percent',
      'cart.discountPercent = percent',
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 120',
    hypothesis: 'The oversell refusal reports on-hand stock instead of what is still available.',
    fixDescription: 'Report the available count in the 409 body.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      "res.end(JSON.stringify({ error: 'not enough stock', available: item.onHand }))",
      "res.end(JSON.stringify({ error: 'not enough stock', available: available(item) }))",
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 400',
    hypothesis: 'Reserving an unknown SKU is reported as a malformed request instead of a missing resource.',
    fixDescription: 'Return 404 when the SKU does not exist.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      "    if (!item) {\n      res.writeHead(400)\n      res.end(JSON.stringify({ error: 'unknown sku' }))",
      "    if (!item) {\n      res.writeHead(404)\n      res.end(JSON.stringify({ error: 'unknown sku' }))",
    ),
  },
  {
    service: 'catalog-service',
    expectedFailure: 'Received: 1800',
    hypothesis: 'A catalog price update is accepted but never applied to the product.',
    fixDescription: 'Persist priceCents on PATCH.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      '      if (patch.name !== undefined) product.name = patch.name\n',
      '      if (patch.name !== undefined) product.name = patch.name\n      if (patch.priceCents !== undefined) product.priceCents = patch.priceCents\n',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 4000',
    hypothesis: 'Reading a cart returns the undiscounted subtotal, disagreeing with what checkout charges.',
    fixDescription: 'Return the discounted total when reading a cart.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'res.end(JSON.stringify({ ...cart, total: subtotal(cart) }))',
      'res.end(JSON.stringify({ ...cart, total: total(cart) }))',
    ),
  },
  {
    service: 'catalog-service',
    expectedFailure: 'Received: true',
    hypothesis: 'Delete removes the entry after the matched one, so the requested product survives.',
    fixDescription: 'Splice at the matched index.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      'products.splice(index + 1, 1)',
      'products.splice(index, 1)',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 2000',
    hypothesis: 'A rejected discount code wipes the discount already on the cart.',
    fixDescription: 'Leave the live discount untouched when refusing an unknown code.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      '        cart.discountPercent = 0\n        res.writeHead(400)',
      '        res.writeHead(400)',
    ),
  },
]

// Each shipped sample app becomes its own product git repository, because that
// is what Canary Lab points at: a repo, not a subdirectory of the workspace.
// `canary-lab init` now does this itself (commitSampleRepos), so on a current
// tarball this is a no-op; it stays as the safety net for `--no-build` runs
// against a pre-fix tarball — which is why it must skip cleanly (an empty
// `git commit` exits 1) instead of assuming there is something to commit.
function commitProductRepo(dir, message) {
  if (!fs.existsSync(path.join(dir, '.git'))) run('git', ['init', '-q'], dir)
  const clean = String(run('git', ['status', '--porcelain'], dir, { quiet: true }).stdout ?? '').trim() === ''
  const committed = run('git', ['rev-parse', '--verify', '-q', 'HEAD'], dir, { quiet: true, allowFailure: true }).status === 0
  if (clean && committed) return
  run('git', ['add', '-A'], dir)
  run('git', [
    '-c', 'user.email=demo@canary-lab.local',
    '-c', 'user.name=Canary Demo',
    'commit', '-qm', message,
  ], dir)
}

async function provision() {
  say('Preparing an isolated workspace')
  let tarballPath
  if (noBuild) {
    const existing = fs.readdirSync(repoRoot).find((entry) => entry.endsWith('.tgz'))
    if (!existing) throw new Error('--no-build needs a packed .tgz in the repository root')
    tarballPath = path.join(repoRoot, existing)
    complete(`Using ${existing}`)
  } else {
    // `npm pack` runs the package's prepack hook, which already performs the
    // full build. Running build separately doubles demo startup time.
    setupTask('Building and packing this checkout', 'Package ready', () => (
      run('npm', ['pack', '--pack-destination', demoRoot], repoRoot, { quiet: interactive })
    ))
    const tarball = fs.readdirSync(demoRoot).find((entry) => entry.endsWith('.tgz'))
    if (!tarball) throw new Error('npm pack did not produce a tarball')
    tarballPath = path.join(demoRoot, tarball)
  }

  run('npm', ['init', '-y'], demoRoot, { quiet: true })
  setupTask('Installing Canary Lab locally', 'Canary Lab installed', () => (
    run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `file:${tarballPath}`], demoRoot, { quiet: interactive })
  ))
  setupTask('Creating the demo project', 'Demo project created', () => (
    run('npx', ['canary-lab', 'init', 'demo-project', '--package-spec', `file:${tarballPath}`, '--no-install'], demoRoot, { quiet: interactive })
  ))
  setupTask('Installing project dependencies', 'Dependencies installed', () => (
    run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir, { quiet: interactive })
  ))

  say('Committing the three sample product repositories')
  commitProductRepo(appDir, 'storefront baseline')
  commitProductRepo(flightAppDir, 'lending baseline')
  commitProductRepo(workflowAppDir, 'workflow workbench baseline')
  // Nothing else. The suite ships inside the scaffold `canary-lab init` just
  // laid down, which is the whole point: what a developer sees here is exactly
  // what a user sees, because it came from the same command.
}

async function bootUi(agent) {
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : await freePort()
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer from 1 to 65535')
  const configPath = path.join(projectDir, 'canary-lab.config.json')
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {}
  fs.writeFileSync(configPath, `${JSON.stringify({
    ...config,
    port,
    healAgent: agent,
    autoProposePr: false,
  }, null, 2)}\n`)

  say(`Starting Canary Lab on http://127.0.0.1:${port}`)
  uiChild = spawn('npx', ['canary-lab', 'ui', '--no-open'], {
    cwd: projectDir,
    env: childEnv,
    stdio: 'inherit',
  })
  await until('the server to answer', 90_000, async () => {
    try {
      const health = await api(port, 'GET', '/mcp/health')
      return health?.ok ? health : null
    } catch {
      return null
    }
  })
  return port
}

async function runInteractive(port, agent) {
  const base = `http://127.0.0.1:${port}`
  console.log(renderInteractiveGuide({
    base,
    agent,
    featureName,
    appDir,
    flightAppDir,
    projectDir,
    intent: demoIntent,
  }))
  await new Promise(() => {})
}

async function waitForRepair(port, runId, stepIndex) {
  const repair = repairSteps[stepIndex]
  // Remember the last thing we actually saw. A timeout here used to say only
  // "timed out waiting for cycle N", which cannot distinguish "the run never
  // healed" from "it healed but surfaced a different assertion than this step
  // expects" — the two have completely different fixes.
  let lastStatus = 'unknown'
  let lastCycles = -1
  let lastFailureText = ''
  try {
    return await until(`repair cycle ${stepIndex + 1} to expose ${repair.service}`, 240_000, async () => {
      const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
      if (detail.manifest.status === 'failed' || detail.manifest.status === 'aborted') {
        throw new Error(`run ended ${detail.manifest.status} before ${repair.service} could be repaired`)
      }
      lastStatus = detail.manifest.status
      lastCycles = detail.manifest.healCycles ?? -1
      lastFailureText = (detail.summary?.failed ?? [])
        .map((failure) => failure.error?.message ?? '')
        .join('\n')
      return detail.manifest.status === 'healing'
        && detail.manifest.healCycles === stepIndex + 1
        && lastFailureText.includes(repair.expectedFailure)
        ? detail
        : null
    })
  } catch (error) {
    if (!/^timed out/.test(error.message)) throw error
    throw new Error(
      `${error.message}\n`
      + `    expected cycle ${stepIndex + 1} with a failure containing ${JSON.stringify(repair.expectedFailure)}\n`
      + `    last seen: status=${lastStatus} healCycles=${lastCycles}\n`
      + `    last failure text:\n${lastFailureText.split('\n').map((l) => `      ${l}`).join('\n') || '      (none)'}`,
    )
  }
}

async function runSmoke(port) {
  say('Starting the canonical three-service journey')
  const started = await api(port, 'POST', '/api/runs', { feature: featureName, env: 'local' })
  const runId = started.runId ?? started.run?.runId
  if (!runId) throw new Error(`no runId in start response: ${JSON.stringify(started)}`)
  console.log(`    run ${runId}`)

  let worktree
  for (const [index, repair] of repairSteps.entries()) {
    const failed = await waitForRepair(port, runId, index)
    // R91: the demo must not be a wall of red. On the FIRST cycle — every other
    // contract still broken — a sound journey has to already be passing, or the
    // suite cannot show that the harness reports what it finds rather than
    // repairing whatever it touches.
    if (index === 0) {
      const passed = failed.summary?.passedNames ?? []
      if (!passed.some((name) => name.startsWith('test-case-j0'))) {
        throw new Error(`no sound journey passed on the first cycle; passed: [${passed.join(', ')}]`)
      }
      console.log(`    (J0 already green while ${repairSteps.length} contracts are still broken)`)
    }
    // Each service is its own repo entry, so each gets its own worktree of the
    // shared source tree. A repair must land in the worktree the BROKEN service
    // is actually serving from — patching a sibling's copy would leave the
    // failing process untouched and the rerun would fail identically.
    worktree = failed.manifest.worktrees?.[repair.service]
    if (!worktree) throw new Error(`the run did not create a per-run worktree for "${repair.service}"`)
    say(`Repair cycle ${index + 1}: fixing ${repair.service} only`)
    repair.apply(worktree)
    await api(port, 'POST', `/api/runs/${encodeURIComponent(runId)}/signal`, {
      kind: 'restart',
      body: {
        hypothesis: repair.hypothesis,
        fixDescription: repair.fixDescription,
      },
    })
  }

  const settled = await until('the third repair rerun to pass', 240_000, async () => {
    const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
    return ['passed', 'failed', 'aborted'].includes(detail.manifest.status) ? detail : null
  })
  const manifest = settled.manifest.status === 'passed'
    ? await until('the fix capture to settle', 30_000, async () => {
        const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
        return detail.manifest.fixCapture ? detail.manifest : null
      }).catch(() => settled.manifest)
    : settled.manifest

  const capture = manifest.fixCapture?.repos ?? []
  const changedFiles = capture.reduce((total, repo) => total + repo.files, 0)
  const capturedFileNames = capture.flatMap((repo) => repo.fileNames ?? []).sort()
  const expectedFileNames = [
    'catalog-service/server.ts',
    'checkout-service/server.ts',
    'inventory-service/server.ts',
  ]
  const problems = []
  if (manifest.status !== 'passed') problems.push(`run ended ${manifest.status}, expected passed`)
  // Derived from repairSteps, never hardcoded: the count moved 3 -> 10 when the
  // demo grew to five journeys, and a literal here silently outlived it.
  if (manifest.healCycles !== repairSteps.length) {
    problems.push(`recorded ${manifest.healCycles} repair cycles, expected ${repairSteps.length}`)
  }
  // Still exactly one server file per service, however many cycles it took.
  if (changedFiles !== expectedFileNames.length) {
    problems.push(`captured ${changedFiles} changed files, expected exactly ${expectedFileNames.length}`)
  }
  if (JSON.stringify(capturedFileNames) !== JSON.stringify(expectedFileNames)) {
    problems.push(`captured [${capturedFileNames.join(', ')}], expected one server file from each service`)
  }

  const finalPassed = settled.summary?.passedNames ?? []
  for (const sound of ['test-case-j0', 'test-case-j6']) {
    if (!finalPassed.some((name) => name.startsWith(sound))) {
      problems.push(`sound journey ${sound} is not green at the end; passed: [${finalPassed.join(', ')}]`)
    }
  }

  say(`Verdict: ${manifest.status.toUpperCase()} — ${manifest.healCycles} repair cycles, ${changedFiles} changed files`)
  if (problems.length > 0) throw new Error(problems.join('; '))
  console.log(`\n✔ smoke:demo passed — seven journeys: two sound throughout, five chained, ${repairSteps.length} defects repaired one per cycle across catalog, inventory and checkout.`)

  if (keepOpen) {
    console.log(`    Open: http://127.0.0.1:${port}/?feature=${featureName}&run=${encodeURIComponent(runId)}`)
    console.log(`    Ctrl-C stops the server and retains the workspace at:\n    ${projectDir}`)
    await new Promise(() => {})
  }
}

// Remove the finished server's live record from the user's REAL
// `~/.canary-lab`. Disposable smoke runs also drop their workspace record;
// interactive demos keep it because their workspace is retained.
function pruneRealHomeState() {
  const changed = pruneDemoStateFromRealHome(
    path.join(os.homedir(), '.canary-lab'),
    demoRoot,
    (message) => console.warn(`    (${message})`),
    { preserveWorkspaceRegistration: interactive },
  )
  for (const file of changed) console.log(`    Removed this demo's entry from ~/.canary-lab/${file}`)
  // Client MCP registrations are intentionally left alone. An interactive
  // demo now points at a retained install; automated smoke runs suppress setup.
}

function cleanup() {
  if (uiChild && !uiChild.killed) uiChild.kill('SIGTERM')
  pruneRealHomeState()
  if (keepOpen && fs.existsSync(projectDir)) return
  try {
    fs.rmSync(demoRoot, { recursive: true, force: true })
  } catch (error) {
    console.warn(`    (could not remove ${demoRoot}: ${error.message})`)
  }
}

async function main() {
  const agent = interactive ? resolveAgent() : 'external'
  await provision()
  const port = await bootUi(agent)
  if (interactive) await runInteractive(port, agent)
  else await runSmoke(port)
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

main()
  .catch((error) => {
    console.error(`\n✘ ${interactive ? 'demo' : 'smoke:demo'} failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(cleanup)
