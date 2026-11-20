import fs from 'fs'
import path from 'path'
import { build, minifySync } from 'vite'
import { REPO as repoRoot } from './lib/fs.mjs'

// Omit contributor comments from the packaged graph, source readers and
// evaluation renderer. Keep the JavaScript readable, including symbol names
// and legal notices. Public type declarations keep their documentation.
for (const moduleDir of ['shared/test-view', 'apps/web-server/src/shared/readable-tests',
  'apps/web-server/src/shared/controlled-english', 'apps/web-server/src/features/evaluation/logic/test-review']) {
  const dir = path.join(repoRoot, 'dist', moduleDir)
  for (const file of fs.readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.js'))) {
    const output = path.join(dir, file)
    const result = minifySync(file, fs.readFileSync(output, 'utf8'), {
      compress: false, mangle: false, codegen: { removeWhitespace: false, legalComments: 'inline' },
    })
    if (result.errors.length) throw new Error(result.errors[0].message)
    fs.writeFileSync(output, result.code)
  }
}

const sourceTemplates = path.join(repoRoot, 'templates')
const distTemplates = path.join(repoRoot, 'dist', 'templates')
const sourcePrompts = path.join(repoRoot, 'apps', 'web-server', 'prompts')
const distPrompts = path.join(repoRoot, 'dist', 'apps', 'web-server', 'prompts')
const sourceAssets = path.join(repoRoot, 'apps', 'web-server', 'assets')
const distAssets = path.join(repoRoot, 'dist', 'apps', 'web-server', 'assets')
const sourceAgentIntegrations = path.join(repoRoot, 'agent-integrations')
const distAgentIntegrations = path.join(repoRoot, 'dist', 'agent-integrations')

// Runtime state that a test run leaves inside the template tree — the server
// defaults its logsDir to <projectRoot>/logs, and the smoke tests boot against
// templates/project itself. It is untracked locally, so only this copy step
// decides whether it ships; without the skip, every scaffolded workspace was
// born carrying stale dirty-spec records for features that no longer exist.
// Paths relative to the copy root, not bare names — `logs` has to be skipped at
// `project/logs` specifically, and a bare-name skip would also drop any nested
// directory that happened to share the name.
const SKIP_TEMPLATE_PATHS = new Set(['project/logs'])

// prompts/benchmark-study/ holds the contributor benchmark's prompts (one prompt
// home), but only tools/benchmark-study renders them, so they never ship.
const SKIP_PROMPT_PATHS = new Set(['benchmark-study'])

function copyDir(sourceDir, targetDir, skip = new Set(), rel = '') {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name
    if (skip.has(entryRel)) continue
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath, skip, entryRel)
      continue
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

fs.rmSync(distTemplates, { recursive: true, force: true })
copyDir(sourceTemplates, distTemplates, SKIP_TEMPLATE_PATHS)

fs.rmSync(distPrompts, { recursive: true, force: true })
copyDir(sourcePrompts, distPrompts, SKIP_PROMPT_PATHS)

fs.rmSync(distAssets, { recursive: true, force: true })
copyDir(sourceAssets, distAssets)

// The offline checker ships as one Node-only file, but its inventory policy is
// authored in the same module as the server's. Never maintain a copied scanner.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: distAssets,
    emptyOutDir: false,
    minify: false,
    lib: { entry: path.join(sourceAssets, 'verify-certificate.mjs'), formats: ['es'], fileName: () => 'verify-certificate.mjs' },
    rollupOptions: { external: (id) => id.startsWith('node:') },
  },
})

fs.rmSync(distAgentIntegrations, { recursive: true, force: true })
copyDir(sourceAgentIntegrations, distAgentIntegrations)
