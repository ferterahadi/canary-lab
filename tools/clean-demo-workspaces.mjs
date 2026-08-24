import os from 'os'
import path from 'path'
import { pruneDemoStateFromRealHome } from './demo-home-prune.mjs'
import {
  demoDirectory,
  parseDemoCleanupArgs,
  referencedDemoRoots,
  removeDemoRoots,
} from './demo-workspace.mjs'

try {
  const { force, olderThanDays } = parseDemoCleanupArgs(process.argv.slice(2))
  const references = referencedDemoRoots()
  const protectedRoots = force ? new Set() : references
  const { removed, skipped } = removeDemoRoots({ olderThanDays, protectedRoots })
  if (removed.length === 0 && skipped.length === 0) {
    console.log(`No matching demo workspaces under ${demoDirectory(os.homedir())}`)
  } else if (removed.length > 0) {
    console.log(`Removed ${removed.length} demo workspace${removed.length === 1 ? '' : 's'}:`)
    for (const target of removed) console.log(`  ${target}`)
  }
  if (force) {
    for (const target of removed) {
      pruneDemoStateFromRealHome(path.join(os.homedir(), '.canary-lab'), target)
    }
  }
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} running or registered demo workspace${skipped.length === 1 ? '' : 's'}:`)
    for (const target of skipped) console.log(`  ${target}`)
    console.log('Re-point MCP clients from a non-demo workspace, stop the demo, then rerun with `--force`.')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
