# Controlled English — Coverage Report

Snapshot of how much of the TypeScript grammar the engine covers and how that
is proven. Numbers re-measured 2026-08-27 against TypeScript 5.9.3.

## Grammar coverage (Phase 1 + Phase 6)

Every `ts.SyntaxKind` is classified in
`apps/web-server/src/shared/controlled-english/syntax-kinds.ts` — 359 kind names, no
gaps (totality is asserted by `syntax-kinds.test.ts` over every enum **value**,
so deprecated aliases can't hide a hole):

- **131 translated kinds** — each with exactly one canonical English form and
  one executable example (`vocabulary.ts`).
- The rest are structural children, operator/keyword/modifier tokens,
  punctuation, trivia, JSDoc, or compiler-internal kinds that a parsed source
  file never presents for translation.
- Anything else throws `UNSUPPORTED_SYNTAX_KIND: <kind>` — proven by synthetic
  nodes in `ast-to-ir.roundtrip.test.ts`, since real parses cannot produce them.

## Test proof (Phases 7–9)

439 tests in `apps/web-server/src/shared/controlled-english/`, all exact-string goldens
or structural assertions — no fuzzy matching:

| Suite | Proves |
| --- | --- |
| `vocabulary.test.ts` | All 131 examples render byte-identically to the catalogue; every translated kind appears in at least one fixture AST |
| `vocabulary-markdown.test.ts` | The generated human catalogue matches the machine-readable tables byte for byte |
| `ast-to-ir.expressions.test.ts` | Every binary/compound/unary operator phrase, calls, construction, optional chains, templates, object/array/arrow/class expressions, condition forms |
| `ast-to-ir.statements.test.ts` | Declarations, bindings, loops, branching, exceptions, classes, interfaces, enums, namespaces, imports/exports, comment lines |
| `ast-to-ir.types.test.ts` | Type syntax (tuples, mapped, conditional, predicates, import types) and JSX |
| `ast-to-ir.roundtrip.test.ts` | Phase 8: 14 look-alike pairs render differently; determinism; unsupported-kind errors; operator tables complete and pairwise distinct |
| `english-renderer.test.ts`, `syntax-kinds.test.ts`, `compiler-context.test.ts` | Layout rules, kind-table integrity + version pin, script-kind resolution |
| `canonical-ir.test.ts`, `semantic-context.test.ts` | Wording-independent IR, TypeChecker Symbols, import/alias/factory/fixture provenance, exact source offsets |
| `semantic-rules.test.ts`, `structured-english.test.ts` | Independent categories, configured adapters, negative classifications, natural composition, nested spans, control flow and theme-independent metadata |

Code coverage over the module: **100% statements (1160/1160), 100% branches
(1010/1010), 100% functions (186/186), 100% lines (1017/1017)**. Reproduce it with:

```sh
npx vitest run apps/web-server/src/shared/controlled-english --coverage \
  '--coverage.include=apps/web-server/src/shared/controlled-english/**/*.ts' \
  --coverage.reporter=text --coverage.reporter=json-summary
```

## Real-corpus run (Phase 10)

The whole engine ran end-to-end over real projects on 2026-08-27. Each file was
parsed and translated twice from scratch, then the two outputs were compared:

| Corpus | Syntax result | Structured semantic result |
| --- | --- | --- |
| This repository — JavaScript/TypeScript under `apps/` and `templates/` | 1,116 files → 781,786 English lines | 100,621 structured blocks |
| `canary-lab-workspace` — JavaScript/TypeScript under `features/` | 292 files → 82,346 English lines | 11,010 structured blocks |
| **Total** | **1,408 files → 864,132 English lines** | **111,631 blocks; 0 unsupported constructs, 0 crashes, 0 nondeterministic renders** |

Reproduce the two rows with:

```sh
node --import tsx tools/check-controlled-english-corpus.ts
```

## Known limits

- Semantic categories require compiler or registered evidence and deliberately
  fall back to ordinary calls when that evidence is absent — see
  [semantic-boundaries.md](semantic-boundaries.md).
- JSDoc comment *structure* is trivia; JSDoc text still surfaces verbatim
  through the ordinary `comment:` lines.
- The grammar version is pinned: a TypeScript upgrade fails
  `syntax-kinds.test.ts` (and the modifier/type-operator tables at compile
  time) until the inventory and vocabulary are re-audited.
