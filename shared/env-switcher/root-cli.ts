import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { execFileSync } from 'child_process'
import { getFeaturesDir } from '../runtime/project-root'
import { section, info, fail, warn, dim, c as ansiC } from '../cli-ui/ui'

const SWITCH_SCRIPT = path.join(__dirname, 'switch.js')

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function selectOption(rl: readline.Interface, label: string, options: string[]): Promise<string> {
  section(label)
  options.forEach((opt, i) => console.log(`  ${ansiC('gray', `${i + 1})`)} ${opt}`))
  while (true) {
    const answer = await prompt(rl, `${ansiC('cyan', '›')} Select [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
    warn(`Please enter a number between 1 and ${options.length}`)
  }
}

export function discoverFeaturesWithEnvSets(featuresDir: string = getFeaturesDir()): string[] {
  return fs.readdirSync(featuresDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(featuresDir, name, 'envsets', 'envsets.config.json')))
    .sort()
}

export function listEnvSets(featureName: string, featuresDir: string = getFeaturesDir()): string[] {
  const envSetsDir = path.join(featuresDir, featureName, 'envsets')
  return fs.readdirSync(envSetsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

export async function main(args = process.argv.slice(2)) {
  let mode = args[0]
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    if (mode !== '--apply' && mode !== '--revert') {
      mode = await selectOption(rl, 'What do you want to do?', [
        'Apply env set',
        'Revert env files',
      ])
      mode = mode.startsWith('Revert') ? '--revert' : '--apply'
    }

    const features = discoverFeaturesWithEnvSets()
    if (features.length === 0) {
      fail('No features with env sets found.')
      process.exit(1)
    }

    const featureName = await selectOption(rl, 'Which feature?', features)

    if (mode === '--revert') {
      console.log('')
      info(`Reverting env for ${featureName}...`)
      execFileSync(process.execPath, [SWITCH_SCRIPT, featureName, '--revert'], { stdio: 'inherit' })
      return
    }

    const envSets = listEnvSets(featureName)
    let chosenSet: string

    if (envSets.length === 1) {
      chosenSet = envSets[0]
      console.log('')
      info(`Using env set: ${chosenSet}`)
    } else {
      chosenSet = await selectOption(rl, `Which env set for ${featureName}?`, envSets)
    }

    execFileSync(process.execPath, [SWITCH_SCRIPT, featureName, '--apply', chosenSet], { stdio: 'inherit' })
  } finally {
    rl.close()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
