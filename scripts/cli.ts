#!/usr/bin/env node

import { main as runRunner } from '../shared/e2e-runner/runner'
import { main as runEnv } from '../shared/env-switcher/root-cli'
import { main as createFeature } from './new-feature'
import { main as initProject } from './init-project'
import { main as upgradeProject } from './upgrade'

export function printUsage(): void {
  console.log(`Canary Lab

Usage:
  canary-lab init <folder> [--package-spec <spec>]
  canary-lab run [--headed] [--terminal iTerm|Terminal]
  canary-lab env
  canary-lab new-feature <name> [description]
  canary-lab upgrade [--silent]
`)
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
      console.error(`Unknown command: ${command}`)
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
