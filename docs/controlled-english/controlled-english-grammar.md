# Controlled English Grammar

The target language of the readable-tests translator: a small, deterministic,
recursive English grammar that TypeScript source is compiled into. The compiler
lives in `apps/web-server/src/shared/controlled-english/`; the per-construct wording is
catalogued in [typescript-ast-vocabulary.md](typescript-ast-vocabulary.md).

Design rule (spec final rule): **precision over natural English**. When a
smoother sentence and an unambiguous one disagree, the unambiguous one wins.

## Readable-test integration

`ast-extractor.ts` parses a Playwright spec once and passes each test callback's
AST to `readable-tests/translator.ts`. That adapter preserves the UI's source
ranges, authored `test.step(...)` labels, helper groups, branches and loop
hierarchy. Every derived description comes from this controlled-English engine;
it never uses a second Playwright-specific wording path or displays the source
snippet as if it were English.

An unsupported syntax kind is a visible `UNSUPPORTED_SYNTAX_KIND: <kind>` row
and makes the readable tree partial. The UI does not substitute raw source code
for that row. Authored `test.step(...)` labels remain exact because they are
literal source data, not inferred descriptions.

## The document model

A translation is a tree of three node forms
(`apps/web-server/src/shared/controlled-english/ir.ts`):

| Form | What it is | Example |
| --- | --- | --- |
| **atom** | One indivisible phrase | `` `userName` ``, `string "on"`, `number 0` |
| **seq** | Phrases joined by single spaces | `` `a` plus `b` `` |
| **clause** | Labelled segments — the recursive unit | `call` + arguments, `if` + branches |

A clause is a list of segments; each segment is a `label`, an optional child
node, or a labelled list of nodes. Everything below follows from how segments
are laid out.

## Layout rules

Rendering (`apps/web-server/src/shared/controlled-english/english-renderer.ts`) is
line-oriented with 4-space indentation. A node is **inline** (one line) when:

- it is an atom, or
- it is a seq whose parts are all inline, or
- it is a clause with no `layout: 'block'` pin, no `separate` segment, every
  child inline, and every list made only of atoms.

Everything else renders as a block:

- An inline child stays on its label's line: `call` + `` `f` `` → `` call `f` ``.
- A block child under a label gets `label:` and one indent level.
- A label-less block child continues at the same depth (how `else if` chains
  stay flat).
- A list renders `label:` with one item per line; an **empty** list renders as
  its bare label (`with no members`).
- An inline list joins as prose: `a`, `a and b`, `a, b and c` — but only when
  every item is an atom. A structured item forces one-per-line, so the joining
  "and" can never blur into an "and" inside an item.

## Verbs force blocks

Nodes tagged as verbs (call, construct, await, yield, assign, arrow-function, …
— `VERB_TAGS` in `ir.ts`) always take their own indented block when they sit in
a value slot. This is the never-flatten rule: `a(b(c()))` renders as

```text
call `a`
with argument:
    call `b`
    with argument:
        call `c` with no arguments
```

Nesting depth in the English is nesting depth in the source, always.

## Grouping

Source parentheses (and structurally forced grouping, e.g. binary operands
that are themselves binary) render as `(…)` when the content is inline, or as
a `group of:` block otherwise. That keeps `(a + b) * c` and `a + b * c`
visually distinct — Phase 8 requires that two different structures never read
identically.

## Names are names

Identifiers render as the bare name in backticks — `` `getUserData` ``, never
"get the user data". Literals keep their type word: `string "on"`,
`number 42`, `bigint 10n`, `regular expression /a+/g`. The translator states
syntax facts; it never interprets what a name means.

## Comments

Comments are not program facts. Each source comment line renders as its own
explicit line:

```text
comment: // retry until the queue drains
```

A file with no statements (or nothing at all) renders as `no statements`.

## Determinism

Identical source text + identical TypeScript version (pinned:
`CONTROLLED_ENGLISH_TYPESCRIPT_VERSION` in
`apps/web-server/src/shared/controlled-english/compiler-context.ts`) always produces
byte-identical English. There is no randomness, no heuristics, no fallback
prose: a construct the vocabulary does not cover throws
`UNSUPPORTED_SYNTAX_KIND: <kind>` instead of rendering something approximate.
