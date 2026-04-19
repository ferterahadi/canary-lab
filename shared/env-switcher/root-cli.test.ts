import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileSync = vi.fn()
const createInterface = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))
vi.mock('readline', () => ({
  createInterface,
  default: { createInterface },
}))

const { discoverFeaturesWithEnvSets, listEnvSets, main } = await import('./root-cli')

const tmpDirs: string[] = []
function mkFeaturesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rcli-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  execFileSync.mockReset()
  createInterface.mockReset()
})

function writeEnvSetsConfig(featuresDir: string, feature: string): void {
  const envSetsDir = path.join(featuresDir, feature, 'envsets')
  fs.mkdirSync(envSetsDir, { recursive: true })
  fs.writeFileSync(path.join(envSetsDir, 'envsets.config.json'), '{}')
}

describe('discoverFeaturesWithEnvSets', () => {
  it('includes only feature dirs that have envsets/envsets.config.json', () => {
    const dir = mkFeaturesDir()
    writeEnvSetsConfig(dir, 'alpha')
    writeEnvSetsConfig(dir, 'beta')
    fs.mkdirSync(path.join(dir, 'no_env_sets'))
    fs.mkdirSync(path.join(dir, 'partial', 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'not-a-dir'), '')

    expect(discoverFeaturesWithEnvSets(dir)).toEqual(['alpha', 'beta'])
  })

  it('returns an empty array when no features qualify', () => {
    const dir = mkFeaturesDir()
    fs.mkdirSync(path.join(dir, 'plain'))
    expect(discoverFeaturesWithEnvSets(dir)).toEqual([])
  })
})

describe('listEnvSets (root-cli)', () => {
  it('lists only directory children of the feature envsets dir, sorted', () => {
    const dir = mkFeaturesDir()
    const envSetsDir = path.join(dir, 'feat', 'envsets')
    fs.mkdirSync(path.join(envSetsDir, 'prod'), { recursive: true })
    fs.mkdirSync(path.join(envSetsDir, 'local'))
    fs.writeFileSync(path.join(envSetsDir, 'envsets.config.json'), '{}')

    expect(listEnvSets('feat', dir)).toEqual(['local', 'prod'])
  })
})

function seedProjectRoot(featureSetup: (featuresDir: string) => void): string {
  const root = mkFeaturesDir()
  const featuresDir = path.join(root, 'features')
  fs.mkdirSync(featuresDir)
  featureSetup(featuresDir)
  vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
  return root
}

function stubExit() {
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new Error(`__exit__${c}`)
  }) as never)
}

function stubReadlineWith(answers: string[]) {
  const close = vi.fn()
  createInterface.mockImplementation(() => ({
    question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
    close,
  }))
  return close
}

describe('main (root-cli orchestration)', () => {
  it('exits 1 when no features with envsets are discovered', async () => {
    seedProjectRoot(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubReadlineWith(['1']) // pick "Apply env set"
    stubExit()
    await expect(main([])).rejects.toThrow('__exit__1')
  })

  it('--apply + single-feature + single-set flows: skips set selection, spawns switch.js', async () => {
    const root = seedProjectRoot((featuresDir) => {
      writeEnvSetsConfig(featuresDir, 'feat')
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'only'))
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const close = stubReadlineWith(['1']) // pick "feat"

    await main(['--apply'])

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [expect.stringMatching(/switch\.js$/), 'feat', '--apply', 'only'],
      { stdio: 'inherit' },
    )
    expect(close).toHaveBeenCalled()
    void root
  })

  it('--apply with multiple sets prompts for set after feature', async () => {
    seedProjectRoot((featuresDir) => {
      writeEnvSetsConfig(featuresDir, 'feat')
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'local'))
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'staging'))
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // answers: "1" feat, "2" staging
    stubReadlineWith(['1', '2'])

    await main(['--apply'])

    expect(execFileSync.mock.calls[0][1]).toEqual([
      expect.stringMatching(/switch\.js$/),
      'feat',
      '--apply',
      'staging',
    ])
  })

  it('--revert spawns switch.js with --revert, skips set selection', async () => {
    seedProjectRoot((featuresDir) => {
      writeEnvSetsConfig(featuresDir, 'feat')
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'local'))
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubReadlineWith(['1'])

    await main(['--revert'])

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [expect.stringMatching(/switch\.js$/), 'feat', '--revert'],
      { stdio: 'inherit' },
    )
  })

  it('interactive mode (no args): first prompt selects Apply/Revert', async () => {
    seedProjectRoot((featuresDir) => {
      writeEnvSetsConfig(featuresDir, 'feat')
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'local'))
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // "2" = Revert, "1" = feat
    stubReadlineWith(['2', '1'])

    await main([])

    expect(execFileSync.mock.calls[0][1]).toEqual([
      expect.stringMatching(/switch\.js$/),
      'feat',
      '--revert',
    ])
  })

  it('selectOption re-prompts on invalid input', async () => {
    seedProjectRoot((featuresDir) => {
      writeEnvSetsConfig(featuresDir, 'feat')
      fs.mkdirSync(path.join(featuresDir, 'feat', 'envsets', 'local'))
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const answers = ['nope', '99', '1']
    stubReadlineWith(answers)

    await main(['--apply'])

    expect(answers).toHaveLength(0)
    expect(execFileSync).toHaveBeenCalledOnce()
  })
})
