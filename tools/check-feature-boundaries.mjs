#!/usr/bin/env node
// Keep apps/web feature boundaries from re-eroding.
//
// A feature may import another feature only through a file that feature has
// declared public in PUBLIC below. There are no barrels: a public file is the
// symbol's one real home, and callers import it directly. Any other path into
// another feature is a second feature depending on an internal file nobody
// declared public — that is how the seam rots.
//
// Tests get two extra allowances, because neither creates a production
// dependency: a `vi.mock(...)` of another feature's module (stubbing what the
// code under test pulls in transitively), and that feature's fixtures
// (`__fixtures__/…` or `*.fixture.*`).
//
// Run: node tools/check-feature-boundaries.mjs
//
// NOTE ON SPELLING: apps/web has TWO shared aliases. `@shared/` is the
// repo-root shared/ package; the web app's own shared dir is `@/shared/`.
// Neither is a feature, so neither is checked here. Both `@/features/…` and
// relative `../../<other-feature>/…` specifiers are resolved, so a rule can't
// pass by matching only one spelling.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(import.meta.dirname, '..')
const SRC = path.join(REPO, 'apps/web/src')
const FEATURES = path.join(SRC, 'features')

// The files each feature lets other features import, relative to the feature
// directory and without an extension. Adding one is a deliberate act: it makes
// that file part of the feature's contract. Keep the list to what is actually
// imported — a stale entry fails the check.
const PUBLIC = {
  config: [
    'components/BranchSuggestInput',
    'components/DeleteSuiteConfirm',
    'components/FolderPicker',
    'components/ModelLaunchGate',
    'components/RepoGitStatusNotice',
    'components/settings-options',
    'state/use-immediate-config',
    'state/use-repo-git-status',
  ],
  coverage: [
    'components/CoverageCards',
    'components/CoverageDocsRail',
    'components/CoverageHeader',
    'components/DocPill',
    'components/DocRelink',
    'components/VerificationDialog',
  ],
  evaluation: ['state/EvaluationExportContext'],
  flights: ['components/stage-meta'],
  portify: [
    'components/PortifyWorkflowControls',
    'components/SavedOverlayPanel',
    'state/PortifyContext',
    'state/portify-state',
  ],
  runs: [
    'components/RunDetailColumn',
    'components/RunRow',
    'state/RunsContext',
    'utils/run-presentation',
    'utils/run-waiting-state',
  ],
  wizard: ['state/WizardDraftContext'],
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const features = readdirSync(FEATURES).filter((f) => statSync(path.join(FEATURES, f)).isDirectory())

// `from '…'`, `import('…')`, `vi.mock('…')`, `vi.importActual<…>('…')`. The
// leading group says which form matched, so a mock can be told apart.
const SPEC = /(vi\.mock\(\s*|from\s+|import\(\s*|importActual(?:<[^>]*>)?\(\s*)'([^']+)'/g
const isTestFile = (file) => /\.test\.tsx?$/.test(file)
const isFixture = (rest) => rest.includes('__fixtures__/') || /\.fixture(\.|$)/.test(rest)

const violations = []
const barrels = []
const used = new Set()

for (const feature of features) {
  for (const file of walk(path.join(FEATURES, feature))) {
    const rel = path.relative(FEATURES, file)
    if (/^[^/]+\/index\.tsx?$/.test(rel)) barrels.push(path.relative(REPO, file))
    const test = isTestFile(file)
    for (const m of readFileSync(file, 'utf8').matchAll(SPEC)) {
      const spec = m[2]
      let abs
      if (spec.startsWith('.')) abs = path.resolve(path.dirname(file), spec)
      else if (spec.startsWith('@/features/')) abs = path.join(SRC, spec.slice(2))
      else continue
      const [target, ...parts] = path.relative(FEATURES, abs).split(path.sep)
      if (target === feature || target.startsWith('..')) continue
      const rest = parts.join('/').replace(/\.tsx?$/, '')
      if (PUBLIC[target]?.includes(rest)) { used.add(`${target}/${rest}`); continue }
      if (test && (m[1].startsWith('vi.mock') || isFixture(rest))) continue
      violations.push({ from: path.relative(REPO, file), spec, target, rest })
    }
  }
}

const stale = Object.entries(PUBLIC).flatMap(([f, files]) =>
  files.filter((r) => !used.has(`${f}/${r}`)).map((r) => `${f}/${r}`))

if (violations.length === 0 && barrels.length === 0 && stale.length === 0) {
  console.log(`✔ feature boundaries clean — ${features.length} web features, ${used.size} declared public files`)
  process.exit(0)
}

for (const v of violations) {
  console.error(`✘ ${v.from}\n    imports ${v.spec}, which ${v.target} has not declared public\n    add '${v.rest}' to PUBLIC.${v.target} in tools/check-feature-boundaries.mjs if it is meant to be shared, or move the shared code to apps/web/src/shared/`)
}
for (const b of barrels) {
  console.error(`✘ ${b} is a feature barrel — import the file that owns each symbol instead`)
}
for (const s of stale) {
  console.error(`✘ PUBLIC lists "${s}" but no other feature imports it — delete the entry`)
}
console.error(`\n${violations.length + barrels.length + stale.length} boundary problem(s).`)
process.exit(1)
