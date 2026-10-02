// A fixed action sequence, not an LLM simulation. Both arms apply the same
// frozen application patch after the first failing suite execution.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const [root, workflow, runDir] = process.argv.slice(2)
const patch = () => {
  for (const { file, content } of JSON.parse(fs.readFileSync(path.join(root, 'replay-patch.json'), 'utf8'))) {
    fs.writeFileSync(path.join(root, 'app', file), content)
  }
}

async function main() {
  if (workflow === 'canary') {
    patch()
    fs.writeFileSync(path.join(runDir, 'signals/.restart'), '')
    return
  }
  const { allocated, environment } = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'))
  const children = []
  const stop = async () => {
    await Promise.all(children.splice(0).map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('close', resolve)
      child.kill('SIGKILL')
    })))
  }
  const start = async () => {
    for (const [service, port] of Object.entries(allocated)) {
      const log = fs.openSync(path.join(root, `${service}.log`), 'a')
      const child = spawn(process.execPath, ['--import', 'tsx', `${service}-service/server.ts`], {
        cwd: path.join(root, 'app'), env: { ...process.env, ...environment, PORT: String(port) }, stdio: ['ignore', log, log],
      })
      fs.closeSync(log)
      let error
      child.on('error', (cause) => { error = cause })
      children.push(child)
      const deadline = Date.now() + 30000
      let ready = false
      while (!ready && Date.now() < deadline) {
        if (error) throw error
        if (child.exitCode !== null) throw new Error(`${service} exited before readiness`)
        try { ready = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok }
        catch { /* local service may not have bound its socket yet */ }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!ready) throw new Error(`${service} readiness timed out`)
    }
  }
  const test = (expected) => {
    const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'suite/playwright.config.ts'], {
      cwd: root, env: { ...process.env, ...environment }, stdio: 'inherit', timeout: 120000,
    })
    if (result.error || result.status !== expected) throw new Error(`Replay expected test exit ${expected}, received ${result.status}: ${result.error ?? ''}`)
  }
  try {
    await start(); test(1); await stop()
    patch()
    await start(); test(0)
  } finally { await stop() }
}
main().catch((error) => { process.stderr.write(`${error}\n`); process.exitCode = 1 })
