# Semantic Boundaries

The readable-test compiler has two deterministic layers. The syntax layer is
total. The semantic layer is conservative and may decline to classify a call.

## The three levels

| Level | Facts | Example for `await getUser(id)` | Contract |
| --- | --- | --- | --- |
| **1 — syntax** | Parser facts: node kinds, names, literals, operators, nesting | `` await: call `getUser` with argument `id` `` | Exhaustive fallback for every supported TypeScript construct |
| **2 — compiler semantics** | Binder/checker facts: Symbols, imports, local aliases, proven fixture origin | `getUser` resolves through an import from `@company/api-client` | Used as evidence by the classifier |
| **3 — registered meaning** | Explicit library/project adapters | The imported client is an `external-api` boundary | Allowed only when a rule names the source of that meaning |

The source pipeline is:

```text
source → TypeScript AST + TypeChecker/Symbols → canonical IR
       → English composition + semantic classifier
       → structured spans → theme renderer
```

The exhaustive syntax compiler remains the fallback. A natural composition
replaces its wording on current UI surfaces only when the canonical IR can
preserve the complete statement. Unknown syntax never disappears and still
surfaces as `UNSUPPORTED_SYNTAX_KIND: <kind>`.

## Proof standard for semantic categories

Database and external API categories use evidence in this order:

1. an import declaration and its TypeChecker Symbol;
2. a local alias or client construction resolved through that Symbol;
3. a built-in adapter for a named library or a proven Playwright fixture;
4. a module specifier registered in `feature.config.cjs` through
   `semanticRules.apiClients` or `semanticRules.databaseClients`.

```js
const config = {
  // existing feature fields...
  semanticRules: {
    apiClients: ['@company/api-client', './src/api/client'],
    databaseClients: ['@company/database'],
  },
}
```

A method name is not evidence. `foo.findMany()` is a normal function call;
`prisma.user.findMany()` is a database call only when `prisma` resolves to a
known database import. Likewise, returned data does not inherit the category of
the call that produced it: `res.json()` remains ordinary after
`res = await request.get(...)`.

Assertions are an explicit API adapter. Known `expect(...).matcher(...)`
matchers receive canonical wording. An unknown matcher keeps the exact call;
the compiler never invents its meaning.

## Structured output and overlap

Each natural block contains ordered spans. Syntax categories (identifier,
literal, operator, function, property, type) and semantic categories
(assertion, database, external API, error control flow, and others) are separate
fields. A span may retain several semantic categories, such as `async` plus
`external-api` inside an assertion.

Blocks and every span retain zero-based source offsets when translation uses a
complete source file. Code spans use their precise expression range; prose
spans use the owning block range. Synthetic body-only inputs omit offsets
rather than publishing positions into their wrapper.

## Determinism boundary

Output is identical for identical source, TypeScript 5.9.3, compiler options,
semantic-rule configuration, and theme. No LLM, randomness, fuzzy matching, or
synonym selection participates.

Changing a theme never changes semantic categories. The default UI maps error
control flow to purple and assertions, external API calls, and database calls
to red; those colours live only in the web theme.

Semantic highlighting is static source analysis. It is not proof that a test
ran or passed. Run verdicts still come only from Playwright execution evidence.
