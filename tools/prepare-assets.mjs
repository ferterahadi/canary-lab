import fs from 'fs'
import path from 'path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sourceTemplates = path.join(repoRoot, 'templates')
const distTemplates = path.join(repoRoot, 'dist', 'templates')

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath)
      continue
    }
    fs.copyFileSync(sourcePath, targetPath)
  }
}

fs.rmSync(distTemplates, { recursive: true, force: true })
copyDir(sourceTemplates, distTemplates)
