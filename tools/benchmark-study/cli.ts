import fs from 'node:fs'
import path from 'node:path'
import { prepare } from './prepare'
import { loadStudy, runStudy } from './study'
import { report } from './report'
import type { StudySelection, StudyDesign } from './types'
import { diagnosisPolicy } from '../../shared/diagnosis-policy'
import { auditStudy } from './audit'

export async function main(argv: string[]): Promise<void> {
  const [operation, ...args] = argv
  const value = (name: string): string => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Required: ${name}`)
    return args[index + 1]
  }
  if (!operation || args.includes('--help') || operation === '--help') {
    process.stdout.write('benchmark:study prepare --workspace <demo-project> --out <new-directory> --codex-model <id> --codex-effort <level> --claude-model <id> --claude-effort <level> [--mode <live|replay>] [--repetitions <2–100>] [--seed <uint32>] [--agent <codex|claude> [--scenario <single-service|cross-service>]] [--diagnosis-policies per-failure,parent-only,adaptive --max-tokens <dispatch-ceiling>]\nbenchmark:study run --study <directory> [--resume]\nbenchmark:study report --study <directory>\nbenchmark:study audit --study <historical-directory> --out <new-audit-directory>\n')
    return
  }
  if (operation === 'prepare') {
    const selection = args.includes('--agent') || args.includes('--scenario')
      ? { agent: value('--agent'), ...(args.includes('--scenario') ? { scenario: value('--scenario') } : {}) } as StudySelection : undefined
    const design: StudyDesign = { mode: (args.includes('--mode') ? value('--mode') : 'live') as StudyDesign['mode'],
      repetitions: args.includes('--repetitions') ? Number(value('--repetitions')) : 10, seed: args.includes('--seed') ? Number(value('--seed')) : 1 }
    if (args.includes('--diagnosis-policies')) design.variants = value('--diagnosis-policies').split(',').map((id) => ({ id, diagnosisPolicy: diagnosisPolicy(id) }))
    const manifest = await prepare({ workspace: value('--workspace'), output: value('--out'), pins: design.mode === 'replay' ? { codex: { model: 'scripted', effort: 'none' }, claude: { model: 'scripted', effort: 'none' } } : {
      codex: { model: value('--codex-model'), effort: value('--codex-effort') },
      claude: { model: value('--claude-model'), effort: value('--claude-effort') },
    }, selection, design, ...(args.includes('--max-tokens') ? { maxTokens: Number(value('--max-tokens')) } : {}) })
    report(manifest)
    process.stdout.write(`Prepared ${manifest.attempts.length} attempts: ${path.join(manifest.root, 'study.json')}\n`)
  } else if (operation === 'run') {
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try { await runStudy(fs.realpathSync(value('--study')), { resume: args.includes('--resume'), signal: controller.signal }) }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  } else if (operation === 'audit') {
    auditStudy(value('--study'), value('--out'))
  } else if (operation === 'report') {
    const manifest = loadStudy(value('--study')); report(manifest)
    process.stdout.write(`${path.join(manifest.root, 'report.html')}\n`)
  } else throw new Error(`Unknown operation: ${operation}`)
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
