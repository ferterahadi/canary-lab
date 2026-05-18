import fs from 'fs'
import path from 'path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sourceTemplates = path.join(repoRoot, 'templates')
const distTemplates = path.join(repoRoot, 'dist', 'templates')
const sourcePrompts = path.join(repoRoot, 'apps', 'web-server', 'prompts')
const distPrompts = path.join(repoRoot, 'dist', 'apps', 'web-server', 'prompts')
const sourceAgentIntegrations = path.join(repoRoot, 'agent-integrations')
const distAgentIntegrations = path.join(repoRoot, 'dist', 'agent-integrations')

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath)
      continue
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

fs.rmSync(distTemplates, { recursive: true, force: true })
copyDir(sourceTemplates, distTemplates)

fs.rmSync(distPrompts, { recursive: true, force: true })
copyDir(sourcePrompts, distPrompts)

fs.rmSync(distAgentIntegrations, { recursive: true, force: true })
copyDir(sourceAgentIntegrations, distAgentIntegrations)
