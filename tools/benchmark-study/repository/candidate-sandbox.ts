import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inside, sha, write } from '../files'

export type CandidatePhase = 'build' | 'host'

export interface CandidateSandbox {
  policy: string
  digest: string
  env: NodeJS.ProcessEnv
}

function cacheReadRoots(cache: string): string[] {
  const root = fs.realpathSync(cache)
  const linked = fs.readdirSync(path.join(root, 'v6'), { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => path.dirname(fs.realpathSync(path.join(root, 'v6', entry.name))))
  const targets = [...new Set(linked)]
  if (targets.length > 1 || targets.some((target) => target === '/' || target === '/Users' || target === '/private')) {
    throw new Error('Yarn cache links do not share one narrow target directory')
  }
  return [root, ...targets]
}

export function candidateSandboxProfile(work: string, phase: CandidatePhase, cache: string, privateRoots: string[] = [],
  writablePaths: string[] = [work], writableFiles: string[] = []): string {
  const writable = fs.realpathSync(work)
  const allowedWrites = writablePaths.map((file) => path.resolve(file))
  const allowedFiles = writableFiles.map((file) => path.resolve(file))
  if ([...allowedWrites, ...allowedFiles].some((file) => !inside(writable, file))) {
    throw new Error('Sandbox writable path escapes candidate work')
  }
  const nodeRuntime = fs.realpathSync(path.dirname(path.dirname(process.execPath)))
  const home = fs.realpathSync(os.homedir())
  const temp = fs.realpathSync(os.tmpdir())
  const sharedTemp = fs.realpathSync('/tmp')
  const cacheRoots = cacheReadRoots(cache)
  const scopedDeny = (root: string, exceptions: string[]): string =>
    `(deny file-read-data (require-all (subpath ${JSON.stringify(root)}) ` +
    `${exceptions.map((file) => `(require-not (subpath ${JSON.stringify(file)}))`).join(' ')}))\n`
  const protectedReads = scopedDeny(home, [nodeRuntime, ...[writable, ...cacheRoots].filter((file) => inside(home, file))]) +
    scopedDeny(temp, [writable, ...cacheRoots.filter((file) => inside(temp, file))]) +
    (sharedTemp === temp ? '' : scopedDeny(sharedTemp, [writable, ...cacheRoots.filter((file) => inside(sharedTemp, file))])) +
    scopedDeny(path.dirname(writable), [writable]) +
    privateRoots.map((file) => {
      const root = fs.realpathSync(file)
      return inside(root, writable) ? scopedDeny(root, [writable]) : `(deny file-read-data (subpath ${JSON.stringify(root)}))\n`
    }).join('')
  const network = phase === 'build'
    ? '(deny network-outbound)\n(deny network-bind)\n'
    : '(deny network-outbound (require-not (remote ip "localhost:3411")))\n' +
      '(deny network-bind (require-not (local ip "localhost:3411")))\n'
  return `(version 1)\n(allow default)\n` +
    protectedReads +
    `(deny file-write* (require-all ${allowedWrites.map((file) => `(require-not (subpath ${JSON.stringify(file)}))`).join(' ')} ` +
    `${allowedFiles.map((file) => `(require-not (literal ${JSON.stringify(file)}))`).join(' ')} ` +
    `(require-not (literal "/dev/null"))))\n` +
    `(deny signal (require-not (target same-sandbox)))\n` +
    `(deny process-info* (require-not (target same-sandbox)))\n` + network
}

export function prepareCandidateSandbox(output: string, work: string, phase: CandidatePhase, cache: string,
  privateRoots: string[] = [], writablePaths: string[] = [work], name: string = phase,
  writableFiles: string[] = []): CandidateSandbox {
  const directory = fs.realpathSync(output)
  const writable = fs.realpathSync(work)
  if (!inside(directory, writable) || directory === writable) throw new Error('Candidate work must be a child of its evaluation output')
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Candidate evaluation requires macOS sandbox-exec; no unrestricted fallback')
  }
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid candidate sandbox policy name')
  const policy = path.join(directory, 'private', `${name}.sb`)
  if (privateRoots.some((file) => inside(writable, file))) throw new Error('Private root lies inside candidate work')
  const contents = candidateSandboxProfile(writable, phase, cache, privateRoots, writablePaths, writableFiles)
  write(policy, contents)
  const home = path.join(writable, 'home')
  const temp = path.join(writable, 'tmp')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(temp, { recursive: true })
  return { policy, digest: sha(contents), env: {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: `${temp}/`, LANG: 'en_US.UTF-8',
    NEXT_TELEMETRY_DISABLED: '1', CI: '1', YARN_CACHE_FOLDER: path.join(writable, 'yarn-cache'),
  } }
}
