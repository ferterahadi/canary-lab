import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

// One storefront, two entry modes:
//
// - `npm run demo` provisions a fresh persistent workspace, prints a link to
//   the real new-Flight dialog, and gives control to the tester. It never
//   starts a run.
// - `npm run smoke:demo` installs an internal feature around the SAME app and
//   drives its three repairs deterministically. The smoke remains an LLM-free
//   contributor gate; it is not the product tour.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const interactive = argv.includes('--interactive')
const noBuild = argv.includes('--no-build')
const keepOpen = interactive || argv.includes('--keep-open')
const portArg = argv.indexOf('--port')
const agentArg = argv.indexOf('--agent')
const requestedAgent = agentArg >= 0 ? argv[agentArg + 1] : 'auto'
const featureName = 'storefront_journey'
const demoIntent = 'Test only the single ordered happy-path purchase: create Espresso Beans at 1800 cents and require SKU espresso-beans in catalog, reserve two units and require available stock to drop by two in inventory, then apply WELCOME10 in checkout and require a placed order totaling 3240 cents. Each assertion must pass before calling the next service; unrelated validation routes are outside this feature.'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lab-demo-'))
const projectDir = path.join(tempRoot, 'demo-project')
const appDir = path.join(projectDir, 'demo-app')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

const childEnv = {
  ...process.env,
  npm_config_cache: cacheDir,
  // Demo state must never disturb another Canary Lab workspace or rewrite the
  // developer's real MCP client registrations.
  CANARY_LAB_HOME: tempRoot,
  CANARY_LAB_AGENT_HOME: tempRoot,
  CANARY_LAB_SKIP_CLIENT_MCP: '1',
}

let step = 0
let uiChild = null

function say(message) {
  step += 1
  console.log(`\n[${step}] ${message}`)
}

function run(command, args, cwd, opts = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    env: childEnv,
  })
  if (result.status !== 0 && !opts.allowFailure) {
    console.error(result.stderr?.toString() ?? '')
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  }
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
]

function scaffoldInternalSmokeFeature() {
  const source = path.join(repoRoot, 'tools', 'fixtures', 'demo-storefront-feature')
  const target = path.join(projectDir, 'features', featureName)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true })
}

function commitProductRepo() {
  if (!fs.existsSync(path.join(appDir, '.git'))) run('git', ['init', '-q'], appDir)
  run('git', ['add', '-A'], appDir)
  run('git', [
    '-c', 'user.email=demo@canary-lab.local',
    '-c', 'user.name=Canary Demo',
    'commit', '-qm', 'storefront baseline',
  ], appDir)
}

async function provision() {
  say(`Scaffolding a fresh workspace in ${projectDir}`)
  let tarballPath
  if (noBuild) {
    const existing = fs.readdirSync(repoRoot).find((entry) => entry.endsWith('.tgz'))
    if (!existing) throw new Error('--no-build needs a packed .tgz in the repository root')
    tarballPath = path.join(repoRoot, existing)
  } else {
    // `npm pack` runs the package's prepack hook, which already performs the
    // full build. Running build separately doubles demo startup time.
    run('npm', ['pack', '--pack-destination', tempRoot], repoRoot)
    const tarball = fs.readdirSync(tempRoot).find((entry) => entry.endsWith('.tgz'))
    if (!tarball) throw new Error('npm pack did not produce a tarball')
    tarballPath = path.join(tempRoot, tarball)
  }

  run('npm', ['init', '-y'], tempRoot, { quiet: true })
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `file:${tarballPath}`], tempRoot)
  run('npx', ['canary-lab', 'init', 'demo-project', '--package-spec', `file:${tarballPath}`, '--no-install'], tempRoot)
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir)

  say('Creating the bare storefront product repository')
  commitProductRepo()
  if (!interactive) scaffoldInternalSmokeFeature()
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
  const url = `http://127.0.0.1:${port}/?dialog=flight-new`
  say('Workspace ready — the tester owns the journey from here')
  console.log(`    Open:       ${url}`)
  console.log(`    Repository: ${appDir}`)
  console.log(`    Intent:     ${demoIntent}`)
  console.log(`    Agent:      ${agent}`)
  console.log('\n    In the dialog: paste the intent, choose the repository, then select Plan flight.')
  console.log('    Nothing has run or healed yet. The UI stays up until Ctrl-C.')
  console.log(`    Ctrl-C stops the server but retains the workspace at:\n    ${projectDir}`)
  await new Promise(() => {})
}

async function waitForRepair(port, runId, stepIndex) {
  const repair = repairSteps[stepIndex]
  return until(`repair cycle ${stepIndex + 1} to expose ${repair.service}`, 240_000, async () => {
    const detail = await api(port, 'GET', `/api/runs/${encodeURIComponent(runId)}`)
    if (detail.manifest.status === 'failed' || detail.manifest.status === 'aborted') {
      throw new Error(`run ended ${detail.manifest.status} before ${repair.service} could be repaired`)
    }
    const failureText = (detail.summary?.failed ?? [])
      .map((failure) => failure.error?.message ?? '')
      .join('\n')
    return detail.manifest.status === 'healing'
      && detail.manifest.healCycles === stepIndex + 1
      && failureText.includes(repair.expectedFailure)
      ? detail
      : null
  })
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
    worktree = failed.manifest.worktrees?.storefront
    if (!worktree) throw new Error('the storefront run did not create its per-run worktree')
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
  if (manifest.healCycles !== 3) problems.push(`recorded ${manifest.healCycles} repair cycles, expected 3`)
  if (changedFiles !== 3) problems.push(`captured ${changedFiles} changed files, expected exactly 3`)
  if (JSON.stringify(capturedFileNames) !== JSON.stringify(expectedFileNames)) {
    problems.push(`captured [${capturedFileNames.join(', ')}], expected one server file from each service`)
  }

  say(`Verdict: ${manifest.status.toUpperCase()} — ${manifest.healCycles} repair cycles, ${changedFiles} changed files`)
  if (problems.length > 0) throw new Error(problems.join('; '))
  console.log('\n✔ smoke:demo passed — one dependency chain revealed and repaired catalog, inventory, then checkout.')

  if (keepOpen) {
    console.log(`    Open: http://127.0.0.1:${port}/?feature=${featureName}&run=${encodeURIComponent(runId)}`)
    console.log(`    Ctrl-C stops the server and retains the workspace at:\n    ${projectDir}`)
    await new Promise(() => {})
  }
}

function cleanup() {
  if (uiChild && !uiChild.killed) uiChild.kill('SIGTERM')
  if (keepOpen && fs.existsSync(projectDir)) return
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch (error) {
    console.warn(`    (could not remove ${tempRoot}: ${error.message})`)
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
