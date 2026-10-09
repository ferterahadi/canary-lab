#!/usr/bin/env node
// Keep the web↔server wire contract from drifting.
//
// The response shapes the web-server returns are declared ONCE, in the root
// `shared/` tree, and both apps import them. They used to be hand-mirrored in
// `apps/web/src/shared/api/**`: when the first version of this gate compared
// the copies field by field, seven had already drifted, and every one compiled
// clean on both sides because a mirror has no link to its original for `tsc`
// to check. Sharing the declaration makes that drift a compile error, so this
// gate now guards the two things `tsc` cannot see:
//
//   1. A mirror creeping back: an app file declaring its own type under a
//      shared wire type's name.
//   2. A shared semantic type that a side bypasses — imports, but builds its
//      own projection instead of calling the shared converter.
//
// Run: node tools/check-wire-contracts.mjs

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { checkSharedBehaviors, checkForbiddenSharedCopies } from './shared-behavior-contracts.mjs'
import { REPO, walk } from './lib/fs.mjs'

// Root files that own wire types. Every exported interface or type alias in
// them is the one declaration of that name; an app file that declares the same
// name is a mirror. Listed, not derived from `shared/**`: a scan reports
// same-name locals with a different shape (TcpProbe, SourceTest,
// HealSignalKind) as copies.
const WIRE_HOMES = [
  'shared/agent-session-types.ts',
  'shared/workspace-events.ts',
  'shared/getting-started.ts',
  'shared/run-manifest.ts',
  'shared/run-detail.ts',
  'shared/playback-identity.ts',
  'shared/test-review.ts',
  'shared/run-index.ts',
  'shared/cleanup-listing.ts',
  'shared/draft-types.ts',
  'shared/evaluation-export-types.ts',
  'shared/extracted-test.ts',
  'shared/coverage/feature-docs.ts',
  'shared/flights/stage-evidence.ts',
  'shared/version-status.ts',
  'shared/portify-index.ts',
  'shared/benchmark-index.ts',
  'shared/record-index-frame.ts',
  'shared/flights/index-entry.ts',
  'shared/config-value.ts',
  'shared/lib/dotenv-edit.ts',
  'shared/verification.ts',
  'shared/run-pr.ts',
  'shared/test-view/cycle-review.ts',
]
const APP_ROOTS = ['apps/web/src', 'apps/web-server/src']

// Shared semantic types with a converter. Importing the type is not enough:
// each side must build the value with the shared function, or a local
// projection can drop or rename a field while still type-checking.
const SHARED_TYPES = [
  {
    name: 'RunIndexEntry',
    declaration: 'shared/run-index.ts',
    consumers: [
      { file: 'apps/web-server/src/features/runs/logic/runtime/run-state-sink.ts', importFrom: '../../../../../../../shared/run-index', importName: 'runIndexEntry', usage: 'return runIndexEntry(' },
      { file: 'apps/web/src/features/runs/state/runs-state.ts', importFrom: '@shared/run-index', importName: 'runIndexEntry', usage: 'const entry = runIndexEntry(' },
    ],
  },
  {
    name: 'PortifyIndexEntry',
    declaration: 'shared/portify-index.ts',
    consumers: [
      { file: 'apps/web-server/src/features/portify/logic/runtime/store.ts', importFrom: '../../../../../../../shared/portify-index', importName: 'portifyIndexEntry', usage: '...portifyIndexEntry(' },
      { file: 'apps/web/src/features/portify/state/portify-state.ts', importFrom: '@shared/portify-index', importName: 'portifyIndexEntry', usage: 'entryOf: portifyIndexEntry' },
    ],
  },
  {
    name: 'PortifyStatus',
    declaration: 'shared/portify-index.ts',
    declarationKind: 'type',
    consumers: [],
  },
  // The full workflow record the server persists and streams. The web client
  // once carried a hand-trimmed mirror that had already lost `featureDir`,
  // `models` and `verification.failureClass`.
  {
    name: 'PortifyManifest',
    declaration: 'shared/portify-index.ts',
    consumers: [
      { file: 'apps/web-server/src/features/portify/logic/runtime/store.ts', importFrom: '../../../../../../../shared/portify-index', usage: 'FileBackedTaskStore<PortifyManifest>' },
      { file: 'apps/web/src/shared/api/portify.ts', importFrom: '@shared/portify-index', usage: 'request<PortifyManifest>(' },
    ],
  },
  { name: 'PortifyVerification', declaration: 'shared/portify-index.ts', consumers: [] },
  { name: 'PortifyBootInstance', declaration: 'shared/portify-index.ts', consumers: [] },
  { name: 'PortifyRepoState', declaration: 'shared/portify-index.ts', consumers: [] },
  {
    name: 'BenchmarkIndexEntry',
    declaration: 'shared/benchmark-index.ts',
    consumers: [
      { file: 'apps/web-server/src/features/benchmark/logic/runtime/store.ts', importFrom: '../../../../../../../shared/benchmark-index', importName: 'benchmarkIndexEntry', usage: '...benchmarkIndexEntry(' },
      { file: 'apps/web/src/features/benchmark/state/benchmark-state.ts', importFrom: '@shared/benchmark-index', importName: 'benchmarkIndexEntry', usage: 'entryOf: benchmarkIndexEntry' },
    ],
  },
  {
    name: 'BenchmarkStatus',
    declaration: 'shared/benchmark-index.ts',
    declarationKind: 'type',
    consumers: [],
  },
  {
    name: 'SabotageLevel',
    declaration: 'shared/benchmark-index.ts',
    declarationKind: 'type',
    consumers: [],
  },
  {
    name: 'ReadableTest',
    declaration: 'shared/readable-tests/types.ts',
    consumers: [
      {
        file: 'shared/extracted-test.ts',
        importFrom: './readable-tests/types',
        usage: 'readable: ReadableTest',
      },
    ],
  },
]

function read(rel) {
  return readFileSync(path.join(REPO, rel), 'utf8')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Variant tags of a discriminated union: every `type: 'tag'` in the alias. */
function unionTags(text, name) {
  const start = new RegExp(`export type ${name}\\s*=`, 'm').exec(text)
  if (!start) return null
  // The alias runs until the next top-level `export ` declaration.
  const rest = text.slice(start.index + start[0].length)
  const end = /\n(?=export )/.exec(rest)
  const body = end ? rest.slice(0, end.index) : rest
  return new Set([...body.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]))
}

const problems = [...checkSharedBehaviors(read), ...checkForbiddenSharedCopies(read)]

const wireNames = new Map()
for (const home of WIRE_HOMES) {
  for (const m of read(home).matchAll(/^export (?:interface|type) ([A-Za-z_]\w*)/gm)) wireNames.set(m[1], home)
}
// A declaration, not an inline `type X,` import specifier.
const declaration = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*)\s*(?:<[^=]*>)?\s*=)/gm
const appFiles = APP_ROOTS.flatMap((dir) => walk(path.join(REPO, dir), { ext: /\.tsx?$/, skip: ['node_modules', 'dist'], excludeTests: true, relativeTo: REPO }))
for (const file of appFiles) {
  for (const m of read(file).matchAll(declaration)) {
    const name = m[1] ?? m[2]
    const home = wireNames.get(name)
    if (home) problems.push(`${name}: ${file} declares its own copy — import it from ${home} instead`)
  }
}

for (const sharedType of SHARED_TYPES) {
  const declaration = read(sharedType.declaration)
  if (!new RegExp(`export ${sharedType.declarationKind ?? 'interface'} ${sharedType.name}\\b`).test(declaration)) {
    problems.push(
      `${sharedType.name}: not declared in ${sharedType.declaration} — the shared-contract registry is stale`,
    )
    continue
  }

  for (const consumer of sharedType.consumers) {
    const source = read(consumer.file)
    const importPattern = new RegExp(
      `import(?:\\s+type)?\\s*\\{[^}]*\\b${consumer.importName ?? sharedType.name}\\b[^}]*\\}` +
      `\\s*from\\s*['\"]${escapeRegExp(consumer.importFrom)}['\"]`,
      's',
    )
    if (!importPattern.test(source)) {
      problems.push(
        `${sharedType.name}: ${consumer.file} must import the canonical type from ${consumer.importFrom}`,
      )
    }
    if (!source.includes(consumer.usage)) {
      problems.push(
        `${sharedType.name}: ${consumer.file} must use it as \`${consumer.usage}\``,
      )
    }
  }
}

const eventTags = unionTags(read('shared/workspace-events.ts'), 'WorkspaceEvent')

if (problems.length === 0) {
  console.log(
    `✔ wire contracts clean — ${wireNames.size} shared wire types, ` +
    `${SHARED_TYPES.length} shared semantic type${SHARED_TYPES.length === 1 ? '' : 's'}, ` +
    `${eventTags.size} event variants`,
  )
  process.exit(0)
}

for (const p of problems) console.error(`✘ ${p}`)
console.error(`\n${problems.length} wire-contract problem(s).`)
process.exit(1)
