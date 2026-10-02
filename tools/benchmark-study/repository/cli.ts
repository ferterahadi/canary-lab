import path from 'node:path'
import { prepareRepositoryStudy } from './adapter'
import { evaluateRepositoryCandidate } from './candidate'
import { probeRepositoryIsolation } from './isolation'
import { validateRepositoryStudy } from './validate'
import { prepareRepositoryCampaign } from './campaign'
import type { StudyDesign, StudySelection } from '../types'
import { diagnosisPolicy } from '../../../shared/diagnosis-policy'
import { loadStudy } from '../study'
import { sha } from '../files'
import fs from 'node:fs'

export async function main(argv: string[]): Promise<void> {
  const [operation, ...args] = argv
  const value = (name: string): string => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Required: ${name}`)
    return args[index + 1]
  }
  if (!operation || args.includes('--help') || operation === '--help') {
    process.stdout.write('Repository adapter (campaign preparation is local; live dispatch requires frozen source-transfer approval):\n' +
      '  prepare --fixture <fixture> --source-checkout <pinned-repo> --out <new-study> [--yarn-cache <folder>]\n' +
      '  probe-isolation --study <study> [--codex-bin <codex-cli>]\n' +
      '  validate --study <study> --playwright-node-modules <workspace-node-modules> [--yarn-cache <folder>]\n' +
      '  evaluate-candidate --study <study> --scenario <clean|overlap|independent> --candidate <source-directory> --playwright-node-modules <workspace-node-modules> --yarn-cache <folder>\n' +
      '  prepare-campaign --study <validated-study> --playwright-node-modules <modules> --yarn-cache <folder> --mode <live|replay> --repetitions <2–100> --seed <uint32> --max-tokens <ceiling> --max-checks <1–100> [--agent <codex|claude>] [--codex-model <pin> --codex-effort <level> --claude-model <pin> --claude-effort <level> --diagnosis-policies per-failure,parent-only]\n' +
      '  --continue-from <stopped-study> preserves every recorded outcome and schedules only the unassigned remainder.\n' +
      'Run and resume prepared campaigns through benchmark:study run --study <directory>.\n')
    return
  }
  if (operation === 'prepare') {
    const manifest = await prepareRepositoryStudy({ fixture: value('--fixture'), sourceCheckout: value('--source-checkout'), output: value('--out'),
      ...(args.includes('--yarn-cache') ? { yarnCacheFolder: value('--yarn-cache') } : {}) })
    process.stdout.write(`Prepared ${path.join(manifest.root, 'repository-study.json')}\n`)
  } else if (operation === 'probe-isolation') {
    const manifest = await probeRepositoryIsolation(value('--study'), args.includes('--codex-bin') ? value('--codex-bin') : undefined)
    process.stdout.write(`Probed ${path.join(manifest.root, 'repository-study.json')}\n`)
  } else if (operation === 'validate') {
    const manifest = await validateRepositoryStudy(value('--study'), value('--playwright-node-modules'),
      args.includes('--yarn-cache') ? value('--yarn-cache') : undefined)
    process.stdout.write(`Validated ${path.join(manifest.root, 'repository-study.json')}\n`)
  } else if (operation === 'prepare-campaign') {
    const design: StudyDesign = { mode: value('--mode') as StudyDesign['mode'], repetitions: Number(value('--repetitions')), seed: Number(value('--seed')) }
    if (args.includes('--diagnosis-policies')) design.variants = value('--diagnosis-policies').split(',').map((id) => ({ id, diagnosisPolicy: diagnosisPolicy(id) }))
    const selection = args.includes('--agent') ? { agent: value('--agent') } as StudySelection : undefined
    if (args.includes('--continue-from')) {
      if (!selection) throw new Error('Continuation requires --agent')
      const previous = loadStudy(value('--continue-from'))
      selection.continuation = { sourceStudy: previous.root, sourceManifestSha256: sha(fs.readFileSync(path.join(previous.root, 'study.json'))),
        recordedAttemptIds: previous.results.map((result) => result.id) }
    }
    const manifest = await prepareRepositoryCampaign({ study: value('--study'), playwrightNodeModules: value('--playwright-node-modules'),
      yarnCacheFolder: value('--yarn-cache'), design, maxTokens: Number(value('--max-tokens')), maxChecks: Number(value('--max-checks')),
      selection,
      pins: design.mode === 'replay' ? { codex: { model: 'scripted', effort: 'none' }, claude: { model: 'scripted', effort: 'none' } }
        : { codex: { model: value('--codex-model'), effort: value('--codex-effort') }, claude: { model: value('--claude-model'), effort: value('--claude-effort') } } })
    process.stdout.write(`Prepared ${manifest.attempts.length} campaign attempts: ${path.join(manifest.root, 'study.json')}\n`)
  } else if (operation === 'evaluate-candidate') {
    const scenario = value('--scenario')
    if (scenario !== 'clean' && scenario !== 'overlap' && scenario !== 'independent') throw new Error(`Unknown repository scenario: ${scenario}`)
    const receipt = await evaluateRepositoryCandidate({ study: value('--study'), scenario, candidate: value('--candidate'),
      playwrightNodeModules: value('--playwright-node-modules'), yarnCacheFolder: value('--yarn-cache') })
    process.stdout.write(`Candidate ${receipt.status}: ${receipt.evidence}\n`)
  } else throw new Error(`Unknown repository adapter operation: ${operation}`)
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
