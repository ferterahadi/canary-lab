import fs from 'node:fs'
import path from 'node:path'
import { checked, command, inside, json, quote, sourceRoot, write } from './files'
import type { Workflow } from './types'

// A workspace-write sandbox alone permits reads of sibling solutions. The study
// additionally denies the reference, recipes and all other attempts at OS level.
export function privatePathsForAttempt(root: string, attempt: string, privatePaths: string[]): string[] {
  const current = fs.realpathSync(attempt)
  const runtime = fs.realpathSync(path.join(root, 'runtime'))
  return [...new Set(privatePaths.map((file) => fs.realpathSync(file)))].map((file) => {
    if (inside(file, current) || inside(current, file) || inside(file, runtime) || inside(runtime, file)) {
      throw new Error(`Private path overlaps an agent-accessible path: ${file}`)
    }
    return file
  })
}

export function profile(root: string, attempt: string, workflow: Workflow = 'canary', privatePaths: string[] = []): string {
  const str = (value: string): string => JSON.stringify(fs.realpathSync(value))
  const denied = privatePathsForAttempt(root, attempt, privatePaths)
  return `(version 1)\n(allow default)\n` +
    `(deny file-read-data (subpath ${str(sourceRoot)}))\n` +
    denied.map((file) => `(deny file-read-data (subpath ${str(file)}))\n(deny file-write* (subpath ${str(file)}))\n`).join('') +
    `(deny file-read-data (require-all (subpath ${str(root)}) (require-not (subpath ${str(attempt)})) (require-not (subpath ${str(path.join(root, 'runtime'))})) ))\n` +
    `(deny file-write* (require-all (subpath ${str(root)}) (require-not (subpath ${str(attempt)}))))\n` +
    `(deny file-write* (subpath ${str(sourceRoot)}))\n` +
    `(deny file-write* (literal ${JSON.stringify(path.join(fs.realpathSync(attempt), 'isolation.sb'))}))\n` +
    (workflow === 'plain' ? `(deny file-read-data (subpath ${str(path.join(root, 'runtime/node_modules/canary-lab'))}))\n` : '')
}
export async function prepareIsolation(root: string, attempt: string, workflow: Workflow = 'canary', localOnly = false, privatePaths: string[] = [], privateProbeFile = path.join(root, 'study.json')): Promise<string> {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Real-agent study currently requires macOS sandbox-exec to prevent solution leakage; no unrestricted fallback')
  }
  const file = path.join(attempt, 'isolation.sb')
  write(file, profile(root, attempt, workflow, privatePaths) + (localOnly
    ? '\n(deny network-outbound (require-not (remote ip "localhost:*")))\n'
    : ''))
  await checked('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', path.join(attempt, 'isolation.sb')], attempt)
  const probeFile = fs.realpathSync(privateProbeFile)
  if (!inside(root, probeFile) || inside(attempt, probeFile) || inside(path.join(root, 'runtime'), probeFile)) throw new Error('Isolation probe must target private study data')
  const probe = await command('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', probeFile], { cwd: attempt })
  if (probe.code === 0 || !/Operation not permitted|Permission denied|EACCES|EPERM/i.test(probe.stderr + probe.stdout)) {
    throw new Error('Isolation probe did not deny private study data')
  }
  if (workflow === 'plain') {
    const canary = await command('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', path.join(root, 'runtime/node_modules/canary-lab/package.json')], { cwd: attempt })
    if (canary.code === 0) throw new Error('Plain workflow can access the Canary package')
  }
  return file
}
export function isolatedShell(file: string, shellCommand: string): string {
  return `/usr/bin/sandbox-exec -f ${quote(file)} /bin/bash -c ${quote(shellCommand)}`
}

/** Native command sandboxes cannot be nested under sandbox-exec on macOS.
 * Keep their enforcement enabled and give each CLI the study's deny rules. */
export async function prepareNativeIsolation(root: string, attempt: string, workflow: Workflow, agent: 'codex' | 'claude', executable = 'codex', privatePaths: string[] = [], privateProbeFile = path.join(root, 'study.json')):
Promise<{ codexArgs: string[]; claudeSettings: string }> {
  if (process.platform !== 'darwin') throw new Error('Native study isolation currently requires macOS')
  const runtime = path.join(root, 'runtime')
  const canaryPackage = path.join(runtime, 'node_modules/canary-lab')
  const settingsFile = path.join(attempt, 'agent-isolation.json')
  const probeFile = fs.realpathSync(privateProbeFile)
  if (!inside(root, probeFile) || inside(attempt, probeFile) || inside(runtime, probeFile)) throw new Error('Native isolation probe must target private study data')
  const deniedPaths = [sourceRoot, ...privatePathsForAttempt(root, attempt, privatePaths), ...fs.readdirSync(root).filter((name) => !['runtime', 'attempts'].includes(name)).map((name) => path.join(root, name)),
    ...fs.readdirSync(path.join(root, 'attempts')).map((name) => path.join(root, 'attempts', name)).filter((file) => file !== attempt),
    ...(workflow === 'plain' ? [canaryPackage] : [])]
  // Keep ancestor metadata readable: Node realpath() walks it while resolving
  // modules. Deny the private children, rather than the shared parent directory.
  const filesystem = { ':root': 'read', [root]: 'read', ...Object.fromEntries(deniedPaths.map((file) => [file, 'deny'])),
    [attempt]: 'write', [runtime]: 'read', [settingsFile]: 'read' }
  const toml = Object.entries(filesystem).map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(',')
  const codexArgs = ['-c', 'default_permissions="canary_study"', '-c', `permissions.canary_study={extends=":workspace",filesystem={${toml}},network={enabled=true}}`]
  json(settingsFile, {
    // The CLI's static read classifier cannot resolve Python file reads reliably.
    // Enforce private-path isolation with explicit rules and the native sandbox.
    permissions: { blockReadsOutsideWorkingDirectories: false, additionalDirectories: [attempt],
      deny: [...deniedPaths.flatMap((file) => [`Read(/${file})`, `Read(/${file}/**)`]), `Edit(/${runtime}/**)`, `Edit(/${settingsFile})`] },
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [attempt], denyWrite: [...deniedPaths, runtime, settingsFile], denyRead: deniedPaths, allowRead: [attempt, runtime] },
      network: { allowLocalBinding: true, allowedDomains: ['localhost', '127.0.0.1'] } },
  })
  if (agent === 'codex') {
    await checked(executable, [...codexArgs, 'sandbox', '/bin/cat', settingsFile], attempt)
    const probe = await command(executable, [...codexArgs, 'sandbox', '/bin/cat', probeFile], { cwd: attempt })
    if (probe.code === 0 || !probe.stderr.includes('Operation not permitted')) throw new Error('Native Codex isolation did not deny private study data')
    if (workflow === 'plain') {
      const packageProbe = await command(executable, [...codexArgs, 'sandbox', '/bin/cat', path.join(canaryPackage, 'package.json')], { cwd: attempt })
      if (packageProbe.code === 0 || !packageProbe.stderr.includes('Operation not permitted')) throw new Error('Plain Codex isolation could read Canary')
    }
  }
  return { codexArgs, claudeSettings: settingsFile }
}
