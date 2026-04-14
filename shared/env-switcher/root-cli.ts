import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { execFileSync } from 'child_process'

const FEATURES_DIR = path.join(__dirname, '../../features')
const SWITCH_SCRIPT = path.join(__dirname, 'switch.ts')

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function selectOption(rl: readline.Interface, label: string, options: string[]): Promise<string> {
  console.log(`\n${label}`)
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`))
  while (true) {
    const answer = await prompt(rl, `Select [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
    console.log(`  Please enter a number between 1 and ${options.length}`)
  }
}

function discoverFeaturesWithEnvSets(): string[] {
  return fs.readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(FEATURES_DIR, name, 'envsets', 'envsets.config.json')))
    .sort()
}

function listEnvSets(featureName: string): string[] {
  const envSetsDir = path.join(FEATURES_DIR, featureName, 'envsets')
  return fs.readdirSync(envSetsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

async function main() {
  const mode = process.argv[2]
  if (mode !== '--apply' && mode !== '--revert') {
    console.error('Usage: root-cli.ts --apply | --revert')
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const features = discoverFeaturesWithEnvSets()
    if (features.length === 0) {
      console.error('No features with env sets found.')
      process.exit(1)
    }

    const featureName = await selectOption(rl, 'Which feature?', features)

    if (mode === '--revert') {
      console.log(`\nReverting env for ${featureName}...`)
      execFileSync('tsx', [SWITCH_SCRIPT, featureName, '--revert'], { stdio: 'inherit' })
      return
    }

    // --apply
    const envSets = listEnvSets(featureName)
    let chosenSet: string

    if (envSets.length === 1) {
      chosenSet = envSets[0]
      console.log(`\n  Using env set: ${chosenSet}`)
    } else {
      chosenSet = await selectOption(rl, `Which env set for ${featureName}?`, envSets)
    }

    execFileSync('tsx', [SWITCH_SCRIPT, featureName, '--apply', chosenSet], { stdio: 'inherit' })
  } finally {
    rl.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
