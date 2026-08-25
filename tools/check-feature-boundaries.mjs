#!/usr/bin/env node
// Keep apps/web feature boundaries from re-eroding.
//
// A feature may import another feature only through its barrel
// (`@/features/<name>`), never a path inside it (`@/features/<name>/state/…`).
// Deep imports are how the seam rots: every one of them is a second feature
// depending on an internal file nobody declared public.
//
// Run: node tools/check-feature-boundaries.mjs
//
// NOTE ON SPELLING: apps/web has TWO shared aliases. `@shared/` is the
// repo-root shared/ package; the web app's own shared dir is `@/shared/`. A
// rule written against the wrong one passes trivially. This checks
// `@/features/…`, which is the only spelling the Phase 2 codemod left behind —
// relative `../../<other-feature>/…` is genuinely absent, so a rule targeting
// that form would also pass while enforcing nothing.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(import.meta.dirname, '..')
const FEATURES = path.join(REPO, 'apps/web/src/features')

// Pairs allowed to keep importing deep, with the reason. Routing BOTH
// directions of a mutual pair through barrels is an ESM module-init cycle, so
// the survivors stay deep deliberately. Shrink this list; don't grow it.
const ALLOWED_DEEP = new Map([
  ['coverage->flights', 'mutual pair with flights — barrels both ways would be an init cycle'],
  ['flights->coverage', 'mutual pair with coverage — barrels both ways would be an init cycle'],
])

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

const violations = []
const usedExemptions = new Set()
const DEEP = /from '@\/features\/([a-z-]+)\/([^']+)'/g

for (const feature of features) {
  for (const file of walk(path.join(FEATURES, feature))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(DEEP)) {
      const target = m[1]
      if (target === feature) continue // own internals are fine
      const key = `${feature}->${target}`
      if (ALLOWED_DEEP.has(key)) { usedExemptions.add(key); continue }
      violations.push({
        from: path.relative(REPO, file),
        key,
        spec: `@/features/${target}/${m[2]}`,
      })
    }
  }
}

// A missing barrel is also a failure: without one there is no legal way in.
const missingBarrels = []
for (const feature of features) {
  const consumed = features.some((other) => {
    if (other === feature) return false
    return walk(path.join(FEATURES, other)).some((f) =>
      readFileSync(f, 'utf8').includes(`from '@/features/${feature}'`) ||
      readFileSync(f, 'utf8').includes(`from '@/features/${feature}/`))
  })
  const hasBarrel = ['index.ts', 'index.tsx'].some((n) => {
    try { return statSync(path.join(FEATURES, feature, n)).isFile() } catch { return false }
  })
  if (consumed && !hasBarrel) missingBarrels.push(feature)
}

const stale = [...ALLOWED_DEEP.keys()].filter((k) => !usedExemptions.has(k))

if (violations.length === 0 && missingBarrels.length === 0 && stale.length === 0) {
  const n = usedExemptions.size
  console.log(`✔ feature boundaries clean — ${features.length} web features, ${n} recorded deep exemption${n === 1 ? '' : 's'}`)
  process.exit(0)
}

for (const v of violations) {
  console.error(`✘ ${v.from}\n    deep import ${v.spec}\n    import from '@/features/${v.key.split('->')[1]}' instead, adding the symbol to that barrel if it is missing`)
}
for (const f of missingBarrels) {
  console.error(`✘ apps/web/src/features/${f} is imported by another feature but has no index.ts barrel`)
}
for (const k of stale) {
  console.error(`✘ ALLOWED_DEEP lists "${k}" but nothing imports that way any more — delete the exemption`)
}
console.error(`\n${violations.length + missingBarrels.length + stale.length} boundary problem(s).`)
process.exit(1)
