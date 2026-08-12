#!/usr/bin/env node
// Freeze the import-cycle debt where it is.
//
// A survey of this repo found 84 circular import chains. Unwinding them is not
// worth doing wholesale: 49 are two sibling React components that render each
// other, which bundlers handle and which no amount of indirection makes clearer.
// The ones that matter are the long, cross-module chains — and the way those get
// added is one edge at a time, invisibly, because nothing counts them.
//
// So this does not demand zero. It pins the current numbers and fails when they
// grow, the way `check-conventions.mjs` pins a gated-file floor. Lowering a
// ceiling after real work is the expected direction of travel.
//
// Cycles are counted as strongly connected components (Tarjan) rather than as
// elementary circuits: circuits are exponential in the worst case and double-count
// the same tangle, while one SCC is one knot of mutually-reachable modules — which
// is the thing a reader actually has to hold in their head.
//
// Run: node tools/check-import-cycles.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(import.meta.dirname, '..')
const ROOTS = ['apps/web/src', 'apps/web-server/src', 'apps/cli', 'shared']

// Current measured state. Raise ONLY with a note saying why the tangle is
// justified; the normal direction is down.
const CEILING = {
  /** Knots of mutually-reachable modules. */
  components: 29,
  /** Modules inside the single largest knot — the real "how much must I read
   *  at once" number, and the one that hurts when it grows.
   *
   *  Was 16: every server feature registrar plus `server.ts` and
   *  `server-context.ts`, held together by ONE type-only back edge
   *  (`server-context` → `server` for `CreateServerOptions`). Moving that type
   *  to the file that already owned the context dissolved the knot.
   *
   *  Now 14, and a different shape: the run orchestrator's own runtime modules
   *  (`orchestrator`, `run-heal-loop`, `run-playwright`, `run-context`, …).
   *  That one is cohesion, not accident — they are one run's lifecycle split
   *  across files — so it is the next target only if it starts costing changes,
   *  and it is a real decomposition rather than a one-edge move. */
  largest: 14,
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      walk(p, out)
    } else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(path.join(REPO, r)))
const known = new Set(files)

/** Resolve a relative specifier to a file we are tracking, trying the
 *  extensions and the directory-index forms TypeScript would. Bare specifiers
 *  (packages) and unresolvable paths are dropped: a cycle through a package is
 *  not this repo's to fix. */
function resolve(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const cand of [
    `${base}.ts`, `${base}.tsx`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ]) {
    if (known.has(cand)) return cand
  }
  return null
}

// `import type` / `export type` edges are erased at compile time, so they cannot
// cause an initialization cycle. They are still counted: a type-only edge is a
// real coupling for a reader and for `tsc`, and excluding them would hide the
// shared→feature inversions this was written to keep an eye on.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*'([^']+)'/g

const graph = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const edges = new Set()
  for (const m of text.matchAll(IMPORT_RE)) {
    const target = resolve(file, m[1])
    if (target && target !== file) edges.add(target)
  }
  graph.set(file, [...edges])
}

// Tarjan, iterative — the graph is a few thousand nodes and a recursive walk
// blows the stack on the deeper chains.
function stronglyConnected() {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const out = []
  let counter = 0

  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work = [[root, 0]]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const [node, childIndex] = frame
      if (childIndex === 0) {
        index.set(node, counter)
        low.set(node, counter)
        counter++
        stack.push(node)
        onStack.add(node)
      }
      const children = graph.get(node) ?? []
      if (childIndex < children.length) {
        frame[1]++
        const child = children[childIndex]
        if (!index.has(child)) work.push([child, 0])
        else if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)))
        continue
      }
      if (low.get(node) === index.get(node)) {
        const component = []
        for (;;) {
          const w = stack.pop()
          onStack.delete(w)
          component.push(w)
          if (w === node) break
        }
        if (component.length > 1) out.push(component)
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
    }
  }
  return out
}

const components = stronglyConnected().sort((a, b) => b.length - a.length)
const largest = components.length > 0 ? components[0].length : 0
const rel = (f) => path.relative(REPO, f)

const problems = []
if (components.length > CEILING.components) {
  problems.push(
    `import cycles grew: ${components.length} knots, ceiling ${CEILING.components}\n` +
    '    break the new cycle, or raise CEILING.components with the reason it is justified',
  )
}
if (largest > CEILING.largest) {
  problems.push(
    `largest cycle grew: ${largest} modules, ceiling ${CEILING.largest}\n` +
    `    ${components[0].map(rel).sort().join('\n    ')}`,
  )
}
// A ceiling nobody lowers is a ratchet in the wrong direction: when real work
// shrinks the tangle, say so, so the new number gets recorded.
if (components.length < CEILING.components || largest < CEILING.largest) {
  problems.push(
    `import cycles shrank to ${components.length} knots / largest ${largest} — ` +
    `lower CEILING to { components: ${components.length}, largest: ${largest} } to keep the win`,
  )
}

if (problems.length === 0) {
  console.log(`✔ import cycles held — ${components.length} knots, largest ${largest} modules`)
  process.exit(0)
}
for (const p of problems) console.error(`✘ ${p}`)
process.exit(1)
