import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { command } from '../files'
import { candidateSandboxProfile, prepareCandidateSandbox } from './candidate-sandbox'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-sandbox-'))); roots.push(root)
  const work = path.join(root, 'work')
  const privateDir = path.join(root, 'private')
  const cache = path.join(root, 'cache')
  for (const dir of [work, privateDir, path.join(cache, 'v6')]) fs.mkdirSync(dir, { recursive: true })
  const secret = path.join(privateDir, 'secret.txt')
  fs.writeFileSync(secret, 'private sentinel\n')
  return { root, work, privateDir, cache, secret }
}

it('builds separate no-network and exact-localhost profiles without inheriting caller secrets', async () => {
  const { root, work, cache } = fixture()
  const build = prepareCandidateSandbox(root, work, 'build', cache)
  const host = prepareCandidateSandbox(root, work, 'host', cache)
  expect(candidateSandboxProfile(work, 'build', cache)).toContain('(deny network-outbound)')
  expect(candidateSandboxProfile(work, 'host', cache)).toContain('localhost:3411')
  expect(build.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  const result = await command('/usr/bin/env', [], { cwd: work, env: build.env, inheritEnv: false })
  expect(result.code, JSON.stringify(result)).toBe(0)
  expect(result.stdout).not.toContain('ANTHROPIC_API_KEY=')
  expect(host.policy).not.toBe(build.policy)
})

it('denies private reads, writes, links and network while allowing work-local controls', async () => {
  const { root, work, cache, secret } = fixture()
  expect(process.platform, 'Native isolation tests require macOS sandbox-exec').toBe('darwin')
  expect(fs.existsSync('/usr/bin/sandbox-exec')).toBe(true)
  const sandbox = prepareCandidateSandbox(root, work, 'build', cache)
  const script = path.join(work, 'probe.py')
  fs.symlinkSync(secret, path.join(work, 'private-alias'))
  fs.writeFileSync(script, `import errno, json, os, socket\nW=${JSON.stringify(work)}\nS=${JSON.stringify(secret)}\nP=${JSON.stringify(sandbox.policy)}\nO={}\ndef check(name,fn):\n try: fn(); O[name]=0\n except OSError as e: O[name]=e.errno\ndef read(p):\n fd=os.open(p,os.O_RDONLY); os.read(fd,1); os.close(fd)\ndef write(p):\n fd=os.open(p,os.O_WRONLY); os.close(fd)\ncheck('allowed_create',lambda: open(os.path.join(W,'allowed'),'w').write('ok'))\ncheck('private_read',lambda: read(S))\ncheck('alias_read',lambda: read(os.path.join(W,'private-alias')))\ncheck('private_write',lambda: write(S))\ncheck('private_create',lambda: open(os.path.join(os.path.dirname(S),'new'),'w').write('x'))\ncheck('private_rename',lambda: os.rename(S,os.path.join(W,'moved')))\ncheck('private_delete',lambda: os.unlink(S))\ncheck('policy_write',lambda: write(P))\ndef connect():\n s=socket.socket(); s.settimeout(1); s.connect(('127.0.0.1',3411)); s.close()\ncheck('network_connect',connect)\ndef bind():\n s=socket.socket(); s.bind(('127.0.0.1',0)); s.close()\ncheck('network_bind',bind)\nprint(json.dumps(O,sort_keys=True))\n`)
  const result = await command('/usr/bin/sandbox-exec', ['-f', sandbox.policy,
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3', script], {
    cwd: work, env: sandbox.env, inheritEnv: false, timeoutMs: 15_000,
  })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const observed = JSON.parse(result.stdout.trim()) as Record<string, number>
  expect(observed.allowed_create).toBe(0)
  for (const [name, error] of Object.entries(observed)) if (name !== 'allowed_create') expect([1, 13], name).toContain(error)
  expect(fs.readFileSync(secret, 'utf8')).toBe('private sentinel\n')
  expect(fs.existsSync(path.join(work, 'moved'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'private/new'))).toBe(false)
}, 30_000)

it('limits the host to loopback port 3411', async () => {
  const { root, work, cache } = fixture()
  expect(process.platform, 'Native isolation tests require macOS sandbox-exec').toBe('darwin')
  expect(fs.existsSync('/usr/bin/sandbox-exec')).toBe(true)
  const sandbox = prepareCandidateSandbox(root, work, 'host', cache)
  const script = path.join(work, 'network-probe.py')
  fs.writeFileSync(script, `import json, socket\nO={}\ndef bind(port):\n s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n try:\n  s.bind(("127.0.0.1",port)); s.listen(1); O["bind_"+str(port)]=0; return s\n except OSError as e:\n  O["bind_"+str(port)]=e.errno; s.close(); return None\ndef connect(host,port,name):\n s=socket.socket(); s.settimeout(1)\n try:\n  s.connect((host,port)); O[name]=0\n except OSError as e: O[name]=e.errno\n finally: s.close()\nserver=bind(3411)\nif server: connect("127.0.0.1",3411,"connect_3411")\nother=bind(3412)\nif other: other.close()\nconnect("127.0.0.1",3412,"connect_3412")\nconnect("1.1.1.1",80,"connect_outbound")\nif server: server.close()\nprint(json.dumps(O,sort_keys=True))\n`)
  const result = await command('/usr/bin/sandbox-exec', ['-f', sandbox.policy,
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3', script], {
    cwd: work, env: sandbox.env, inheritEnv: false, timeoutMs: 15_000,
  })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const observed = JSON.parse(result.stdout.trim()) as Record<string, number>
  expect(observed.bind_3411).toBe(0)
  expect(observed.connect_3411).toBe(0)
  for (const name of ['bind_3412', 'connect_3412', 'connect_outbound']) expect(observed[name], name).toBe(1)
}, 30_000)

it('keeps frozen host files read-only and blocks signals to the evaluator', async () => {
  const { root, work, cache } = fixture()
  expect(process.platform, 'Native isolation tests require macOS sandbox-exec').toBe('darwin')
  expect(fs.existsSync('/usr/bin/sandbox-exec')).toBe(true)
  const source = path.join(work, 'source')
  const host = path.join(work, 'host')
  fs.mkdirSync(source); fs.mkdirSync(host)
  fs.writeFileSync(path.join(host, 'config.txt'), 'frozen\n')
  const sandbox = prepareCandidateSandbox(root, work, 'build', cache, [], [source], 'narrow-build')
  const script = path.join(source, 'probe.py')
  fs.writeFileSync(script, `import json, os\nS=${JSON.stringify(source)}\nH=${JSON.stringify(host)}\nP=${process.pid}\nO={}\ndef check(name,fn):\n try: fn(); O[name]=0\n except OSError as e: O[name]=e.errno\ncheck('source_create',lambda: open(os.path.join(S,'new'),'w').write('ok'))\ncheck('host_write',lambda: open(os.path.join(H,'config.txt'),'w').write('changed'))\ncheck('host_create',lambda: open(os.path.join(H,'new'),'w').write('changed'))\ncheck('external_signal',lambda: os.kill(P,0))\ncheck('self_signal',lambda: os.kill(os.getpid(),0))\nprint(json.dumps(O,sort_keys=True))\n`)
  const result = await command('/usr/bin/sandbox-exec', ['-f', sandbox.policy,
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3', script], {
    cwd: source, env: sandbox.env, inheritEnv: false, timeoutMs: 15_000,
  })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const observed = JSON.parse(result.stdout.trim()) as Record<string, number>
  expect(observed.source_create).toBe(0)
  expect(observed.self_signal).toBe(0)
  for (const name of ['host_write', 'host_create', 'external_signal']) expect(observed[name], name).toBe(1)
  expect(fs.readFileSync(path.join(host, 'config.txt'), 'utf8')).toBe('frozen\n')
}, 30_000)
