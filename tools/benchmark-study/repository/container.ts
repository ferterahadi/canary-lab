import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { inside, json, sha, type CommandResult } from '../files'
import { ContainerGuardian } from './container-guardian'
import { recoveryLabel } from './container-recovery'

export const candidateImage = 'node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e'
const dockerExecutable = '/usr/local/bin/docker'

interface ContainerRecord { id: string; name: string; created: boolean; stopped: boolean; removed: boolean; exitCode?: string }
interface ContainerState {
  image: string
  volume: string
  volumeCreated: boolean
  volumeRemoved: boolean
  containers: ContainerRecord[]
  cleanupErrors: string[]
}

export class CandidateContainers {
  private readonly privateDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly cache: string
  private readonly state: ContainerState
  private readonly signal?: AbortSignal
  private readonly guardian: ContainerGuardian
  private readonly owner = randomUUID()
  private cleanupTask?: Promise<void>
  private cleaning = false

  constructor(output: string, cache: string, signal?: AbortSignal) {
    this.privateDir = path.join(output, 'private')
    fs.mkdirSync(this.privateDir, { recursive: true })
    const socket = path.join(os.homedir(), '.colima/default/docker.sock')
    if (!fs.existsSync(socket) || !fs.statSync(socket).isSocket()) throw new Error('Local Colima Docker socket is unavailable')
    const config = path.join(this.privateDir, 'docker-config')
    fs.mkdirSync(config, { recursive: true })
    json(path.join(config, 'config.json'), { auths: {} })
    this.env = { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: config }
    this.cache = fs.realpathSync(cache)
    this.signal = signal
    if (!inside(os.homedir(), this.cache) || !fs.statSync(path.join(this.cache, 'v6')).isDirectory()) {
      throw new Error('Container Yarn cache must be a narrow local home directory with v6 packages')
    }
    this.state = { image: candidateImage, volume: `canary-candidate-${sha(output).slice(0, 20)}`,
      volumeCreated: false, volumeRemoved: false, containers: [], cleanupErrors: [] }
    this.save()
    this.guardian = new ContainerGuardian({ privateDir: this.privateDir, env: this.env, executable: dockerExecutable,
      owner: this.owner, volume: this.state.volume,
      containers: ['build', 'host'].map((phase) => `${this.state.volume}-${phase}`) })
    signal?.addEventListener('abort', () => this.guardian.abort(), { once: true })
  }

  private save(): void { json(path.join(this.privateDir, 'container-state.json'), this.state) }

  async run(args: string[], timeoutMs = 120_000, log?: string): Promise<CommandResult> {
    if (!this.cleaning && this.signal?.aborted) throw new Error('Candidate evaluation interrupted')
    return this.guardian.run(args, timeoutMs, log)
  }

  async checked(args: string[], timeoutMs = 120_000, log?: string): Promise<string> {
    const result = await this.run(args, timeoutMs, log)
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`Docker ${args[0]} failed (${result.code ?? result.signal}); ${log ?? result.stderr.trim()}`)
    }
    return result.stdout.trim()
  }

  async verifyRuntime(): Promise<void> {
    await this.checked(['info', '--format', '{{.ServerVersion}}'])
    await this.checked(['image', 'inspect', candidateImage, '--format', '{{.Id}}'])
    if (await this.run(['volume', 'inspect', this.state.volume]).then((result) => result.code === 0)) {
      throw new Error(`Previous candidate Docker volume still exists: ${this.state.volume}`)
    }
  }

  async createVolume(): Promise<void> {
    await this.checked(['volume', 'create', '--label', `${recoveryLabel}=${this.owner}`, this.state.volume])
    this.state.volumeCreated = true
    this.save()
  }

  async create(phase: 'build' | 'host'): Promise<string> {
    const name = `${this.state.volume}-${phase}`
    if (await this.run(['container', 'inspect', name]).then((result) => result.code === 0)) {
      throw new Error(`Previous candidate Docker container still exists: ${name}`)
    }
    const mounts = [
      `type=bind,src=${this.cache},dst=/global-cache,readonly`,
      `type=volume,src=${this.state.volume},dst=/source${phase === 'host' ? ',readonly' : ''}`,
    ]
    const args = ['create', '--name', name, '--platform', 'linux/arm64', '--pull', 'never', '--network', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '4g',
      '--label', `canary.benchmark.output=${sha(this.privateDir)}`, '--env', 'YARN_CACHE_FOLDER=/work/cache',
      '--label', `${recoveryLabel}=${this.owner}`,
      '--env', 'NEXT_TELEMETRY_DISABLED=1', '--env', 'CI=1',
      ...mounts.flatMap((mount) => ['--mount', mount]), candidateImage, 'sleep', 'infinity']
    const record: ContainerRecord = { id: name, name, created: false, stopped: false, removed: false }
    this.state.containers.push(record)
    this.save()
    const id = await this.checked(args)
    record.id = id
    record.created = true
    this.save()
    await this.checked(['start', id])
    return id
  }

  async copyIn(source: string, id: string, destination: string): Promise<void> {
    await this.checked(['cp', source, `${id}:${destination}`], 180_000)
  }

  async copyOut(id: string, source: string, destination: string): Promise<void> {
    await this.checked(['cp', `${id}:${source}`, destination], 180_000)
  }

  async exec(id: string, args: string[], log?: string, timeoutMs = 180_000, cwd?: string): Promise<string> {
    return this.checked(['exec', ...(cwd ? ['-w', cwd] : []), id, ...args], timeoutMs, log)
  }

  async initCache(id: string): Promise<void> {
    const script = `const fs=require('fs');fs.mkdirSync('/work/cache/v6',{recursive:true});for(const name of fs.readdirSync('/global-cache/v6'))fs.symlinkSync('/global-cache/v6/'+name,'/work/cache/v6/'+name)`
    await this.exec(id, ['node', '-e', script])
  }

  async stop(id: string): Promise<void> {
    const record = this.state.containers.find((container) => container.id === id)
    if (!record) throw new Error(`Unknown candidate container: ${id}`)
    const status = await this.run(['inspect', id, '--format', '{{.State.Running}} {{.State.Pid}}'])
    if (status.code !== 0) throw new Error(`Candidate container disappeared before verified stop: ${id}`)
    if (status.stdout.trim().startsWith('true ')) await this.checked(['kill', id], 15_000)
    record.exitCode = await this.checked(['wait', id], 15_000)
    const stopped = await this.checked(['inspect', id, '--format', '{{.State.Running}} {{.State.Pid}}'])
    if (stopped !== 'false 0') throw new Error(`Candidate container is not stopped: ${id}: ${stopped}`)
    record.stopped = true
    this.save()
  }

  async remove(id: string): Promise<void> {
    const record = this.state.containers.find((container) => container.id === id)
    if (!record?.stopped) throw new Error(`Candidate container has no verified stop: ${id}`)
    await this.checked(['rm', id], 15_000)
    if ((await this.run(['inspect', id])).code === 0) throw new Error(`Candidate container still exists: ${id}`)
    record.removed = true
    this.save()
  }

  cleanup(): Promise<void> {
    return this.cleanupTask ??= this.finishCleanup()
  }

  private async finishCleanup(): Promise<void> {
    this.cleaning = true
    const receipt = await this.guardian.finish()
    if (receipt.status === 'cleaned') {
      for (const record of this.state.containers) { record.stopped = true; record.removed = true }
      this.state.volumeRemoved = true
    }
    this.state.cleanupErrors.push(...receipt.errors)
    this.save()
    if (receipt.status !== 'cleaned') throw new Error(`Candidate Docker cleanup unverified: ${receipt.errors.join('; ')}`)
  }

  async startRelay(id: string, log: string): Promise<{ close: () => Promise<void> }> {
    const sockets = new Set<net.Socket>()
    const children = new Set<ChildProcess>()
    const recordError = (error: unknown): void => { fs.appendFileSync(log, `${String(error)}\n`) }
    const script = `const net=require('net');const socket=net.connect(3411,'127.0.0.1');process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('error',error=>{process.stderr.write(String(error));process.exitCode=1});socket.on('close',()=>process.exit())`
    const server = net.createServer((socket) => {
      sockets.add(socket)
      const child = spawn(dockerExecutable, ['exec', '-i', id, 'node', '-e', script], {
        env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      })
      children.add(child)
      socket.pipe(child.stdin)
      child.stdout.pipe(socket)
      socket.on('error', recordError)
      child.stdin.on('error', recordError)
      child.stdout.on('error', recordError)
      child.stderr.on('error', recordError)
      child.stderr.on('data', (chunk: Buffer) => fs.appendFileSync(log, chunk))
      child.on('error', (error) => { recordError(error); socket.destroy() })
      child.on('close', () => { children.delete(child); socket.destroy() })
      socket.on('close', () => { sockets.delete(socket); child.kill('SIGKILL') })
    })
    server.on('error', recordError)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(3411, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    return { close: async () => {
      for (const socket of sockets) socket.destroy()
      for (const child of children) child.kill('SIGKILL')
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } }
  }
}
