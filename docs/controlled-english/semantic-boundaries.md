# Semantic Boundaries

What the controlled-English translator is allowed to know, and why it stops
where it does.

## The three levels

| Level | Facts | Example for `await getUser(id)` | Status |
| --- | --- | --- | --- |
| **1 — Syntax** | What the parser alone can see: node kinds, names as written, literal values, structure, operators, modifiers | ``await:`` / ``    call `getUser` with argument `id` `` | **This is the engine.** Everything it emits is Level 1. |
| **2 — Semantics** | What the binder/checker adds: resolved symbols, inferred types, which overload, where a name was declared | "calls the `getUser` declared in `api/users.ts`, returns `Promise<User>`" | Deliberately excluded. |
| **3 — Interpretation** | What a human/domain layer adds: intent, domain meaning, library knowledge | "fetches the user record" | Deliberately excluded from this engine. |

## Why parser-only (Level 1)

- **Determinism.** A parse depends on nothing but the source text and the
  pinned TypeScript version. Binder and checker output depends on tsconfig,
  installed dependencies, ambient types, and lib versions — the same file
  would translate differently in different projects.
- **Totality.** Every parseable file translates. A checker-based translation
  fails or degrades on unresolvable imports; a Playwright spec must translate
  even when its project has never run `npm install`.
- **Honesty.** A Level-1 line can only be wrong if the parser is wrong. The
  moment inferred meaning enters, the translation can assert things the code
  does not say — the exact failure mode the rewrite removed.

Concretely: `parseSource` (`apps/web-server/src/shared/controlled-english/compiler-context.ts`)
calls `ts.createSourceFile` only. No `ts.createProgram`, no `getTypeChecker`.

## What "names must remain names" rules out

The previous translator rendered `expect(locator).toBeVisible()` as
Playwright-flavoured prose ("check that … is visible"). That is Level-3
interpretation: it requires knowing what `toBeVisible` means, which the syntax
does not state. In controlled English the same code reads as the call it is —
`` call method `toBeVisible` … `` — and is correct for any library, any
misspelling, any user-defined function with the same name.

An interpretive layer may return later as a clearly separated, optional
Level-3 annotation on top of the Level-1 rendering — never replacing it, and
never presented as a fact of the code.

## Level-1 subtleties the engine still states

Some facts feel semantic but are pure syntax, so they are in scope:

- `const` vs `let` vs `var` vs `using` (declaration flags).
- `?.` vs `.` (distinct node kinds/tokens: "optional property" vs "property").
- `a ?? b` vs `a || b` (distinct operator tokens).
- Definite-assignment `!`, optional `?`, `readonly`, decorators, modifiers.
- Comment text (verbatim, labelled `comment:` — stated but never interpreted).

What stays out even though it looks easy: whether `foo.bar` resolves, whether
a call is sync or async apart from an explicit `await`, whether an import is
type-only *at use sites* (only the written `type` keyword is stated), and any
guess about what a template string evaluates to.
