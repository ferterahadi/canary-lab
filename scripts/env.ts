import { main as switchEnv } from '../apps/web-server/lib/runtime/env-switcher/switch'
import { fail } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, feature, set] = args
  if (command === 'apply' && feature && set) {
    await switchEnv([feature, '--apply', set])
    return
  }
  if (command === 'revert' && feature) {
    await switchEnv([feature, '--revert'])
    return
  }

  fail('Usage: canary-lab env apply <feature> <set> | canary-lab env revert <feature>')
  process.exit(1)
}

runAsScript(module, () => main())
