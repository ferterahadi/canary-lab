#!/usr/bin/env node

import { main as initProject } from './init-project'
import { main as upgradeProject } from './upgrade'
import { runUi } from './ui-command'
import { main as createFeature } from './new-feature'
import { main as runEnv } from './env'
import { banner, section, dim, fail, line } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'
import readline from 'readline'

function confirmYn(orphanCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(
      `Move ${orphanCount} orphaned log file(s) to logs/_pre-0.10.x-archive/<ts>/? [y/N] `,
      (ans) => {
        rl.close()
        resolve(/^y(es)?$/i.test(ans.trim()))
      },
    )
  })
}

export function printUsage(): void {
  banner('Canary Lab')
  section('Usage')
  console.log(`  canary-lab init <folder> ${dim('[--package-spec <spec>]')}`)
  console.log(`  canary-lab ui ${dim('[--port <n>]')}`)
  console.log(`  canary-lab new feature <name> ${dim('[--description "..."]')}`)
  console.log(`  canary-lab new-feature <name> ${dim('[--description "..."]')}`)
  console.log(`  canary-lab env apply <feature> <set>`)
  console.log(`  canary-lab env revert <feature>`)
  console.log(`  canary-lab upgrade ${dim('[--silent] [--check] [--force-archive]')}`)
  line()
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv

  switch (command) {
    case 'init':
      await initProject(args)
      return
    case 'ui':
      await runUi(args)
      return
    case 'new':
      if (args[0] !== 'feature') {
        fail('Usage: canary-lab new feature <name> [--description "..."]')
        process.exit(1)
        return
      }
      await createFeature(args.slice(1))
      return
    case 'new-feature':
      await createFeature(args)
      return
    case 'env':
      await runEnv(args)
      return
    case 'upgrade':
      await upgradeProject(args, { confirm: confirmYn })
      return
    // Test execution still lives in the web UI. Feature/env commands above are
    // deterministic wrappers for agents and compatibility.
    case 'run':
      fail(`\`canary-lab ${command}\` was removed. Use \`canary-lab ui\` to run tests, edit envsets, and manage feature config from the web UI.`)
      process.exit(1)
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

runAsScript(module, main)
