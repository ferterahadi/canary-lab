import fs from 'node:fs'
import path from 'node:path'
import { command, json, quote, readJson } from '../files'
import { prepareIsolation, prepareNativeIsolation } from '../isolation'
import { loadRepositoryStudy, repositoryScenarios, type RepositoryScenario, type RepositoryStudyManifest } from './adapter'

const deniedMessage = /Operation not permitted|Permission denied|EACCES|EPERM/i

async function readProbe(executable: string, args: string[], cwd: string, shouldAllow: boolean): Promise<void> {
  const result = await command(executable, args, { cwd, timeoutMs: 15_000 })
  if (shouldAllow ? result.code !== 0 : result.code === 0 || !deniedMessage.test(result.stderr + result.stdout)) {
    throw new Error(`Repository isolation ${shouldAllow ? 'blocked allowed' : 'allowed protected'} read: ${args.at(-1)}`)
  }
}

async function writeProbe(executable: string, args: string[], cwd: string, target: string, shouldAllow: boolean): Promise<void> {
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined
  const result = await command(executable, args, { cwd, timeoutMs: 15_000 })
  const after = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined
  if (!shouldAllow && after !== before) {
    if (before === undefined) fs.rmSync(target, { force: true })
    else fs.writeFileSync(target, before)
  }
  if (shouldAllow ? result.code !== 0 || after !== 'allowed' : result.code === 0 || !deniedMessage.test(result.stderr + result.stdout) || after !== before) {
    throw new Error(`Repository native isolation ${shouldAllow ? 'blocked allowed' : 'allowed protected'} write: ${target}`)
  }
}

async function osIsolation(manifest: RepositoryStudyManifest, scenario: RepositoryScenario): Promise<string[]> {
  const attempt = path.join(manifest.root, 'attempts', scenario)
  const privateRoots = [manifest.fixtureRoot, manifest.sourceCheckout]
  const policy = await prepareIsolation(manifest.root, attempt, 'canary', true, privateRoots,
    path.join(manifest.root, 'repository-study.json'))
  const denied = [
    path.join(manifest.fixtureRoot, 'manifest.json'),
    path.join(manifest.fixtureRoot, 'source.tar.gz'),
    path.join(manifest.fixtureRoot, 'oracle/e2e/encoding.spec.ts'),
    path.join(manifest.fixtureRoot, 'held-out/overlap.patch'),
    path.join(manifest.fixtureRoot, 'held-out/independent.patch'),
    path.join(manifest.sourceCheckout, 'package.json'),
    path.join(manifest.sourceCheckout, '.git/HEAD'),
    path.join(manifest.root, 'repository-study.json'),
    path.join(manifest.root, 'frozen/fixture/manifest.json'),
    path.join(manifest.root, 'attempts', scenario === 'clean' ? 'overlap' : 'clean', 'source/package.json'),
  ]
  for (const target of denied) await readProbe('/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', target], attempt, false)
  const alias = path.join(attempt, 'private-alias-probe')
  fs.symlinkSync(path.join(manifest.fixtureRoot, 'source.tar.gz'), alias)
  try { await readProbe('/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', alias], attempt, false) }
  finally { fs.unlinkSync(alias) }
  await readProbe('/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', path.join(attempt, 'source/package.json')], attempt, true)
  const writable = path.join(attempt, 'allowed-write-probe')
  const allowedWrite = await command('/usr/bin/sandbox-exec', ['-f', policy, '/bin/sh', '-c', `printf allowed > ${quote(writable)}`], { cwd: attempt })
  if (allowedWrite.code !== 0 || fs.readFileSync(writable, 'utf8') !== 'allowed') throw new Error('Repository isolation blocked attempt-local write')
  fs.unlinkSync(writable)
  const protectedWrite = path.join(manifest.root, 'protected-write-probe')
  fs.writeFileSync(protectedWrite, 'unchanged')
  try {
    const result = await command('/usr/bin/sandbox-exec', ['-f', policy, '/bin/sh', '-c', `printf changed > ${quote(protectedWrite)}`], { cwd: attempt })
    if (result.code === 0 || !deniedMessage.test(result.stderr + result.stdout) || fs.readFileSync(protectedWrite, 'utf8') !== 'unchanged') {
      throw new Error('Repository isolation allowed protected write')
    }
  } finally { fs.unlinkSync(protectedWrite) }
  const policyWrite = await command('/usr/bin/sandbox-exec', ['-f', policy, '/bin/sh', '-c', `printf changed >> ${quote(policy)}`], { cwd: attempt })
  if (policyWrite.code === 0 || !deniedMessage.test(policyWrite.stderr + policyWrite.stdout)) throw new Error('Agent can edit its own isolation policy')
  return [...denied.map((target) => path.relative(manifest.root, target)), 'symlink alias', 'attempt read/write allowed', 'private write denied', 'policy write denied']
}

async function nativeCodexIsolation(manifest: RepositoryStudyManifest, scenario: RepositoryScenario, executable: string): Promise<'passed'> {
  const attempt = path.join(manifest.root, 'attempts', scenario)
  const native = await prepareNativeIsolation(manifest.root, attempt, 'canary', 'codex', executable,
    [manifest.fixtureRoot, manifest.sourceCheckout], path.join(manifest.root, 'repository-study.json'))
  for (const target of [path.join(manifest.fixtureRoot, 'manifest.json'), path.join(manifest.sourceCheckout, 'package.json'),
    path.join(manifest.root, 'frozen/fixture/manifest.json'), path.join(manifest.root, 'repository-study.json'),
    path.join(manifest.root, 'attempts', scenario === 'clean' ? 'overlap' : 'clean', 'source/package.json')]) {
    await readProbe(executable, [...native.codexArgs, 'sandbox', '/bin/cat', target], attempt, false)
  }
  const alias = path.join(attempt, 'native-private-alias-probe')
  fs.symlinkSync(path.join(manifest.fixtureRoot, 'source.tar.gz'), alias)
  try { await readProbe(executable, [...native.codexArgs, 'sandbox', '/bin/cat', alias], attempt, false) }
  finally { fs.unlinkSync(alias) }
  await readProbe(executable, [...native.codexArgs, 'sandbox', '/bin/cat', path.join(attempt, 'source/package.json')], attempt, true)
  const allowedWrite = path.join(attempt, 'native-allowed-write-probe')
  try {
    await writeProbe(executable, [...native.codexArgs, 'sandbox', '/bin/sh', '-c', `printf allowed > ${quote(allowedWrite)}`], attempt, allowedWrite, true)
  } finally { fs.rmSync(allowedWrite, { force: true }) }
  const protectedWrite = path.join(manifest.root, 'frozen/native-protected-write-probe')
  fs.writeFileSync(protectedWrite, 'unchanged')
  try {
    await writeProbe(executable, [...native.codexArgs, 'sandbox', '/bin/sh', '-c', `printf changed > ${quote(protectedWrite)}`], attempt, protectedWrite, false)
  } finally { fs.unlinkSync(protectedWrite) }
  await writeProbe(executable, [...native.codexArgs, 'sandbox', '/bin/sh', '-c', `printf changed >> ${quote(native.claudeSettings)}`],
    attempt, native.claudeSettings, false)
  const settings = readJson<{ sandbox: { enabled: boolean; failIfUnavailable: boolean; filesystem: { denyRead: string[]; denyWrite: string[] } } }>(native.claudeSettings)
  if (!settings.sandbox.enabled || !settings.sandbox.failIfUnavailable ||
      ![manifest.fixtureRoot, manifest.sourceCheckout].every((file) => settings.sandbox.filesystem.denyRead.includes(file) && settings.sandbox.filesystem.denyWrite.includes(file))) {
    throw new Error('Claude native settings omit repository private roots')
  }
  return 'passed'
}

export async function probeRepositoryIsolation(root: string, codexExecutable?: string): Promise<RepositoryStudyManifest> {
  const manifest = loadRepositoryStudy(root)
  const receipts = {} as NonNullable<RepositoryStudyManifest['isolation']>
  for (const scenario of repositoryScenarios) {
    const probes = await osIsolation(manifest, scenario)
    receipts[scenario] = { osSandbox: 'passed', nativeCodex: codexExecutable ? await nativeCodexIsolation(manifest, scenario, codexExecutable) : 'unverified',
      nativeClaude: 'unverified', probes }
  }
  manifest.isolation = receipts
  json(path.join(manifest.root, 'repository-study.json'), manifest)
  return manifest
}
