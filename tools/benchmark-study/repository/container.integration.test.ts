import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { CandidateContainers } from './container'
import { command } from '../files'

it('kills a reparented detached candidate child at the container boundary', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-container-test-'))
  const containers = new CandidateContainers(output, path.join(os.homedir(), 'Library/Caches/Yarn'))
  try {
    await containers.verifyRuntime()
    await containers.createVolume()
    const id = await containers.create('build')
    const childScript = `process.env={};process.chdir('/tmp');process.on('SIGTERM',()=>{});setInterval(()=>require('fs').writeFileSync('/tmp/detached-heartbeat',String(Date.now())),50)`
    const launcher = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});child.unref();process.stdout.write(String(child.pid))`
    const pid = Number(await containers.exec(id, ['node', '-e', launcher]))
    expect(pid).toBeGreaterThan(1)
    await containers.exec(id, ['sh', '-c', `kill -0 ${pid} && sleep 1 && test -s /tmp/detached-heartbeat`])
    const running = await containers.checked(['inspect', id, '--format', '{{.State.Running}} {{.State.Pid}}'])
    expect(running).toMatch(/^true [1-9]/)
    await containers.stop(id)
    expect(await containers.checked(['inspect', id, '--format', '{{.State.Running}} {{.State.Pid}}'])).toBe('false 0')
    await containers.remove(id)
  } finally {
    await containers.cleanup()
    fs.rmSync(output, { recursive: true, force: true })
  }
}, 120_000)

it.each(['volume', 'build', 'host', 'busy'])(
  'recovers %s resources after evaluator SIGKILL', async (phase) => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-crash-test-'))
    const log = fs.openSync(path.join(output, 'evaluator.log'), 'a')
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'),
      path.join(__dirname, '__fixtures__/crash-evaluator.ts'), output, path.join(os.homedir(), 'Library/Caches/Yarn'), phase],
    { detached: true, stdio: ['ignore', 'ignore', log] })
    fs.closeSync(log)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      await expect.poll(() => fs.existsSync(path.join(output, 'ready')), { timeout: 30_000 }).toBe(true)
      const state = JSON.parse(fs.readFileSync(path.join(output, 'private/container-state.json'), 'utf8'))
      child.kill('SIGKILL')
      await exited
      const recoveryFile = path.join(output, 'private/container-recovery.json')
      await expect.poll(() => JSON.parse(fs.readFileSync(recoveryFile, 'utf8')).status, { timeout: 30_000 }).toBe('cleaned')
      const receipt = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'))
      expect(receipt.reason).toBe('evaluator-disconnected')
      expect(receipt.errors).toEqual([])
      expect(fs.existsSync(path.join(output, 'private/verdict.json'))).toBe(false)
      for (const [kind, name] of [['volume', state.volume], ...receipt.containers.map((name: string) => ['container', name])]) {
        const result = await command('/usr/local/bin/docker', [kind, 'inspect', name], {
          cwd: output, env: { DOCKER_HOST: `unix://${path.join(os.homedir(), '.colima/default/docker.sock')}` },
        })
        expect(result.code).toBe(1)
        expect(result.stderr).toMatch(/no such (container|object|volume)(:|\s*$)/i)
      }
      const recovered = JSON.parse(fs.readFileSync(path.join(output, 'private/container-state.json'), 'utf8'))
      expect(recovered.volumeRemoved).toBe(true)
      expect(recovered.containers.every((entry: { stopped: boolean; removed: boolean }) => entry.stopped && entry.removed)).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      // Keep failed-run evidence so recovery can continue if Docker is unavailable.
      const receipt = path.join(output, 'private/container-recovery.json')
      if (fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')).status === 'cleaned') {
        fs.rmSync(output, { recursive: true, force: true })
      }
    }
  }, 120_000)
