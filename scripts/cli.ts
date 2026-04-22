#!/usr/bin/env node

import { main as runRunner } from '../shared/e2e-runner/runner'
import { main as runEnv } from '../shared/env-switcher/root-cli'
import { main as createFeature } from './new-feature'
import { main as initProject } from './init-project'
import { main as upgradeProject } from './upgrade'
import { banner, section, dim, fail, line } from '../shared/cli-ui/ui'

export function printUsage(): void {
  banner('Canary Lab')
  section('Usage')
  console.log(`  canary-lab init <folder> ${dim('[--package-spec <spec>]')}`)
  console.log(`  canary-lab run ${dim('[--headed] [--terminal iTerm|Terminal] [--heal-session resume|new]')}`)
  console.log(`                 ${dim('[--benchmark] [--benchmark-mode canary|baseline]')}`)
  console.log(`  canary-lab env`)
  console.log(`  canary-lab new-feature <name> ${dim('[description]')}`)
  console.log(`  canary-lab upgrade ${dim('[--silent]')}`)
  line()
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv

  switch (command) {
    case 'init':
      await initProject(args)
      return
    case 'run':
      await runRunner(args)
      return
    case 'env':
      await runEnv(args)
      return
    case 'new-feature':
      await createFeature(args)
      return
    case 'upgrade':
      await upgradeProject(args)
      return
    case '-h':
    case '--help':
    case undefined:
      printUsage()
      return
    default:
      fail(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
