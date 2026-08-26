#!/usr/bin/env node
// Keep the web↔server wire contract from drifting.
//
// `apps/web/src/shared/api/**` hand-mirrors the response shapes the web-server
// returns. That mirror is deliberate — the web app must not import server code,
// and the semantic primitives that DO deserve sharing already live in the root
// `shared/` tree (`run-state.ts`, `flights/types.ts`, …) where both sides import
// them. What was missing is the other half: nothing checked that a hand-copy
// still matches the thing it copies.
//
// It didn't. When this gate was written, seven of the mirrored types had already
// drifted — server fields the UI could not see, web fields the server never
// sends — and every one of them compiled clean on both sides, because a mirror
// has no link to its original for `tsc` to check.
//
// This is the same shape of rule as `check-feature-boundaries.mjs`: registries
// of mirrored and shared contracts, an allowlist of recorded exceptions with
// reasons, and a failure when an allowlist entry stops being needed. Shrink
// BASELINE; don't grow it.
//
// Run: node tools/check-wire-contracts.mjs

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(import.meta.dirname, '..')
const WEB_API = 'apps/web/src/shared/api'

// Each entry: the type as the SERVER declares it, and where. `webName` only
// when the mirror was given a different name — a rename across the seam hides
// the pairing from every grep, so it is recorded here rather than discovered.
const PAIRS = [
  { name: 'RunIndexEntry', server: 'apps/web-server/src/features/runs/logic/runtime/manifest.ts' },
  { name: 'ServiceManifestEntry', server: 'apps/web-server/src/features/runs/logic/runtime/manifest.ts' },
  { name: 'RunManifest', server: 'apps/web-server/src/features/runs/logic/runtime/manifest.ts' },
  { name: 'RepoBranchSnapshot', server: 'apps/web-server/src/features/runs/logic/runtime/manifest.ts' },
  { name: 'ExternalHealSession', server: 'apps/web-server/src/features/runs/logic/runtime/manifest.ts' },
  { name: 'RunDetail', server: 'apps/web-server/src/features/runs/logic/run-detail.ts' },
  { name: 'RunSummary', server: 'apps/web-server/src/features/runs/logic/run-detail.ts' },
  { name: 'RunSummaryFailedEntry', server: 'apps/web-server/src/features/runs/logic/run-detail.ts' },
  { name: 'RunSummaryRunningStep', server: 'apps/web-server/src/features/runs/logic/run-detail.ts' },
  // Renamed across the seam: the server calls one markdown section a
  // `JournalSection`; the web calls the same wire object a `JournalEntry`. A
  // DIFFERENT server type is also called `JournalEntry` (heal-journal.ts), so
  // matching these by name would pair the wrong two.
  { name: 'JournalSection', webName: 'JournalEntry', server: 'apps/web-server/src/features/runs/logic/journal-store.ts' },
  { name: 'PlaywrightArtifact', server: 'apps/web-server/src/features/runs/logic/run-artifacts.ts' },
  { name: 'PlaywrightArtifactGroup', server: 'apps/web-server/src/features/runs/logic/run-artifacts.ts' },
  { name: 'CleanupListing', server: 'apps/web-server/src/features/runs/logic/run-cleanup.ts' },
  { name: 'CleanupOrphan', server: 'apps/web-server/src/features/runs/logic/run-cleanup.ts' },
  { name: 'CleanupRunEntry', server: 'apps/web-server/src/features/runs/logic/run-cleanup.ts' },
  { name: 'PortifyCleanupEntry', server: 'apps/web-server/src/features/portify/logic/runtime/cleanup.ts' },
  { name: 'PortifyCleanupListing', server: 'apps/web-server/src/features/portify/logic/runtime/cleanup.ts' },
  { name: 'DraftRecord', server: 'apps/web-server/src/features/wizard/logic/draft-types.ts' },
  { name: 'DraftRepo', server: 'apps/web-server/src/features/wizard/logic/draft-types.ts' },
  { name: 'DraftPrdDocument', server: 'apps/web-server/src/features/wizard/logic/draft-types.ts' },
  // Renamed across the seam: `…TaskView` is the server's projection of its
  // stored record; the web receives exactly that object and calls it `…Task`.
  { name: 'EvaluationExportTaskView', webName: 'EvaluationExportTask', server: 'apps/web-server/src/features/evaluation/logic/evaluation-export-types.ts' },
  { name: 'EvaluationArchiveContents', server: 'apps/web-server/src/features/evaluation/logic/evaluation-export-types.ts' },
  { name: 'ExtractedTest', server: 'apps/web-server/src/shared/ast-extractor.ts' },
  { name: 'ExtractedStep', server: 'apps/web-server/src/shared/ast-extractor.ts' },
  { name: 'FeatureDoc', server: 'apps/web-server/src/features/coverage/logic/coverage/feature-docs.ts' },
  { name: 'FeatureDocsListing', server: 'apps/web-server/src/features/coverage/logic/coverage/feature-docs.ts' },
  { name: 'FeatureStageEvidence', server: 'apps/web-server/src/features/flights/logic/stage-evidence.ts' },
  { name: 'UpdateJobManifest', server: 'apps/web-server/src/features/version/logic/update-job.ts' },
  { name: 'VersionStatus', server: 'apps/web-server/src/features/version/logic/version-state.ts' },
]

// Semantic types that deliberately have no web mirror. Both sides must import
// and use the root declaration, otherwise matching field names can conceal a
// different nested shape from the mirrored-interface check above.
const SHARED_TYPES = [
  {
    name: 'ReadableTest',
    declaration: 'shared/readable-tests/types.ts',
    consumers: [
      {
        file: 'apps/web-server/src/shared/ast-extractor.ts',
        importFrom: '../../../../shared/readable-tests/types',
        usage: 'readable: ReadableTest',
      },
      {
        file: 'apps/web/src/shared/api/types.ts',
        importFrom: '@shared/readable-tests/types',
        usage: 'readable: ReadableTest',
      },
    ],
  },
]

// The workspace WebSocket frame union, declared on both sides. Compared by
// variant tag rather than by field, because that is what a client switches on.
const UNION = {
  server: { file: 'apps/web-server/src/shared/workspace-events.ts', name: 'WorkspaceEvent' },
  web: { file: 'apps/web/src/shared/api/workspace-socket.ts', name: 'WorkspaceEvent' },
  // The web union carries the socket's own lifecycle frame, which the server's
  // event bus never emits — `workspace-stream.ts` adds it around the bus.
  webOnly: ['connected'],
}

// Recorded drift, each with the reason it is not simply fixed. An entry lists
// the fields allowed to differ; any OTHER difference on the same type still
// fails. Shrink this; don't grow it.
const BASELINE = new Map([
  ['EvaluationExportTaskView', {
    onlyServer: ['producer'],
    onlyWeb: ['producer?'],
    reason: 'optionality-only: the server projection defaults it (`record.producer ?? \'internal\'`) so it is always sent; the mirror stays optional to tolerate exports archived before the field existed',
  }],
  ['ExtractedTest', {
    onlyServer: ['requirements?', 'pathTypes?', 'variants?', 'assertions?'],
    onlyWeb: [],
    reason: 'not drift: the AST extractor\'s type is an INTERNAL superset, and `GET /api/features/:name/tests` builds each entry fresh from name/line/bodySource/steps/readable(/sourceFile). The mirror describes that projection. The coverage-linkage fields never leave the server — the UI reads them off the coverage payload — so mirroring them would describe a wire that does not exist',
  }],
  ['FeatureStageEvidence', {
    onlyServer: ['booted', 'portInjectability'],
    onlyWeb: ['booted?', 'portInjectability?'],
    reason: 'optionality-only: server always stamps both, web tolerates pre-1.5 records that lack them',
  }],
])

function read(rel) {
  return readFileSync(path.join(REPO, rel), 'utf8')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a relative import specifier for `name` in `rel` to a repo-relative
 *  path, so an inherited base interface can be followed across files. Returns
 *  null for a bare specifier (a package), which no wire type inherits from. */
function resolveImportOf(rel, name) {
  const text = read(rel)
  const spec = new RegExp(`import(?:\\s+type)?\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`, 's').exec(text)
  if (!spec || !spec[1].startsWith('.')) return null
  return `${path.normalize(path.join(path.dirname(rel), spec[1]))}.ts`
}

/** Field set of `export interface NAME { … }` — top-level members only, so a
 *  nested object type (`error?: { message: string }`) contributes `error?` and
 *  not its inner fields.
 *
 *  Inherited members count: `ExternalHealSession extends ExternalSessionMeta`
 *  puts `sessionId`/`clientKind` on the wire just as surely as an own member
 *  does, and the web mirror spells them out inline. Reading own members only
 *  reported that pair as drifted in both directions — a false positive, and a
 *  gate nobody trusts is worse than no gate.
 *
 *  Returns null when the type is absent, or is not an interface (a type alias
 *  has no comparable member list here). */
function interfaceFields(text, name, rel) {
  const head = new RegExp(`export interface ${name}\\s*(?:extends ([^{]+))?\\{`, 'm').exec(text)
  if (!head) return null
  const inherited = new Set()
  for (const base of (head[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    // Same file first, then the file it is imported from.
    let baseFields = interfaceFields(text, base, rel)
    if (!baseFields && rel) {
      const baseRel = resolveImportOf(rel, base)
      if (baseRel) {
        try { baseFields = interfaceFields(read(baseRel), base, baseRel) } catch { baseFields = null }
      }
    }
    if (!baseFields) {
      // Never guess: an unresolved base would silently under-report the type's
      // real surface, which is exactly the false positive this exists to avoid.
      throw new Error(`cannot resolve base interface "${base}" of "${name}" from ${rel ?? 'unknown file'}`)
    }
    for (const f of baseFields) inherited.add(f)
  }
  const fields = new Set(inherited)
  let depth = 1
  let atTop = true
  let line = ''
  for (let i = head.index + head[0].length; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      if (atTop && depth === 1) {
        const m = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\??):/.exec(line)
        if (m) fields.add(m[1] + (m[2] || ''))
      }
      line = ''
      atTop = depth === 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) break
    }
    line += c
  }
  return fields
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

const webFiles = readdirSync(path.join(REPO, WEB_API))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => `${WEB_API}/${f}`)

function findWebDecl(name) {
  for (const rel of webFiles) {
    const fields = interfaceFields(read(rel), name, rel)
    if (fields) return { rel, fields }
  }
  return null
}

const problems = []
const usedBaseline = new Set()

for (const pair of PAIRS) {
  const webName = pair.webName ?? pair.name
  const serverFields = interfaceFields(read(pair.server), pair.name, pair.server)
  if (!serverFields) {
    problems.push(`${pair.name}: not declared in ${pair.server} — the registry entry is stale, fix or remove it`)
    continue
  }
  const web = findWebDecl(webName)
  if (!web) {
    problems.push(`${webName}: no declaration found under ${WEB_API}/ — the registry entry is stale, fix or remove it`)
    continue
  }

  const onlyServer = [...serverFields].filter((f) => !web.fields.has(f)).sort()
  const onlyWeb = [...web.fields].filter((f) => !serverFields.has(f)).sort()
  const allowed = BASELINE.get(pair.name)
  if (allowed) usedBaseline.add(pair.name)

  const unexpectedServer = onlyServer.filter((f) => !(allowed?.onlyServer ?? []).includes(f))
  const unexpectedWeb = onlyWeb.filter((f) => !(allowed?.onlyWeb ?? []).includes(f))
  if (unexpectedServer.length === 0 && unexpectedWeb.length === 0) {
    // A baseline that over-promises is as misleading as a missing one: it would
    // keep excusing a field that has since been reconciled.
    const goneServer = (allowed?.onlyServer ?? []).filter((f) => !onlyServer.includes(f))
    const goneWeb = (allowed?.onlyWeb ?? []).filter((f) => !onlyWeb.includes(f))
    if (goneServer.length || goneWeb.length) {
      problems.push(
        `${pair.name}: BASELINE lists ${[...goneServer, ...goneWeb].join(', ')} but ${
          goneServer.length && goneWeb.length ? 'those fields' : 'that field'
        } now agrees — remove it from the baseline`,
      )
    }
    continue
  }

  const lines = [`${pair.name}${pair.webName ? ` (web: ${pair.webName})` : ''} has drifted`]
  lines.push(`    server: ${pair.server}`)
  lines.push(`    web:    ${web.rel}`)
  if (unexpectedServer.length) lines.push(`    only on server: ${unexpectedServer.join(', ')}`)
  if (unexpectedWeb.length) lines.push(`    only on web:    ${unexpectedWeb.join(', ')}`)
  lines.push('    add the field to the other side, or record it in BASELINE with the reason it differs')
  problems.push(lines.join('\n'))
}

for (const [name] of BASELINE) {
  if (!usedBaseline.has(name)) {
    problems.push(`BASELINE lists "${name}" but no PAIRS entry checks it any more — delete the baseline entry`)
  }
}

for (const sharedType of SHARED_TYPES) {
  const declaration = read(sharedType.declaration)
  if (!new RegExp(`export interface ${sharedType.name}\\b`).test(declaration)) {
    problems.push(
      `${sharedType.name}: not declared in ${sharedType.declaration} — the shared-contract registry is stale`,
    )
    continue
  }

  for (const consumer of sharedType.consumers) {
    const source = read(consumer.file)
    const importPattern = new RegExp(
      `import(?:\\s+type)?\\s*\\{[^}]*\\b${sharedType.name}\\b[^}]*\\}` +
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

// The workspace event union.
const serverTags = unionTags(read(UNION.server.file), UNION.server.name)
const webTags = unionTags(read(UNION.web.file), UNION.web.name)
if (!serverTags || !webTags) {
  problems.push(`WorkspaceEvent: could not read the union on ${!serverTags ? 'the server' : 'the web'} side`)
} else {
  const missingOnWeb = [...serverTags].filter((t) => !webTags.has(t)).sort()
  const missingOnServer = [...webTags].filter((t) => !serverTags.has(t) && !UNION.webOnly.includes(t)).sort()
  if (missingOnWeb.length) {
    problems.push(
      `WorkspaceEvent: the server emits ${missingOnWeb.join(', ')} but ${UNION.web.file} does not handle it —\n` +
      '    a client that never learns the tag stays stale until the user reloads',
    )
  }
  if (missingOnServer.length) {
    problems.push(
      `WorkspaceEvent: ${UNION.web.file} declares ${missingOnServer.join(', ')} but nothing emits it —\n` +
      '    dead branch, or a server publisher was removed without its client',
    )
  }
}

if (problems.length === 0) {
  console.log(
    `✔ wire contracts clean — ${PAIRS.length} mirrored types, ` +
    `${SHARED_TYPES.length} shared semantic type${SHARED_TYPES.length === 1 ? '' : 's'}, ` +
    `${serverTags.size} event variants, ${BASELINE.size} recorded drift${BASELINE.size === 1 ? '' : 's'}`,
  )
  process.exit(0)
}

for (const p of problems) console.error(`✘ ${p}`)
console.error(`\n${problems.length} wire-contract problem(s).`)
process.exit(1)
