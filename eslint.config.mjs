import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

// Narrow on purpose. ESLint was added because 46 `eslint-disable` directives sat
// in this repo with no ESLint installed — 46 statements that were not true. The
// job of this config is to make them true, not to import someone's house style.
//
// TWO MEASUREMENTS SHAPED IT, both of which contradicted the plan:
//
//   1. `js.configs.recommended` reported 1,800 findings. 1,556 were the CORE
//      `no-unused-vars` rule misreading TypeScript (type-only usage, interfaces,
//      declaration merging) — which is precisely why @typescript-eslint ships a
//      replacement — plus 38 `no-useless-escape` in regexes nobody had questioned.
//      No preset here.
//
//   2. Enabling exactly the rules the directives referenced still reported 116
//      errors, because the directives were never a map of the rule surface. They
//      sat wherever someone once hit an error in an editor; the same patterns
//      occur ~110 more times with no directive. Almost all of it was test-fixture
//      `any` (97) and `require()` inside `vi.mock` factories (8) — both deliberate
//      and correct here. So the rules are scoped to where the repo actually wants
//      them, which is source, not tests.
//
// The mechanical conventions this repo does care about — filename case, explained
// catches, alias scope, coverage pragmas, test placement, coverage scope — live in
// tools/check-conventions.mjs: no type information, 0.09s, and it runs in the edit
// hook. ESLint here covers only what needs a type checker or the React plugin.
//
// Widening this is a deliberate act: add a rule, run it, and fix or baseline what
// it finds in the same commit.

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'apps/web/dist/**',
      'coverage/**',
      // Scaffold templates ship to users verbatim; not this repo's source, and
      // covered by no tsconfig.
      'templates/**',
      'node_modules/**',
      // Outside every tsconfig project, so type-aware parsing fails on them.
      '**/__fixtures__/**',
      '*.config.ts',
      'apps/web/vite.config.ts',
      // In tsconfig.web-server.json but NOT tsconfig.build.json, so the project
      // service cannot place it. That gap is a real finding about the build
      // graph, not a lint problem — tracked separately, ignored here.
      'apps/web-server/src/features/coverage/logic/coverage/jobs/paths.ts',
    ],
  },
  // Type-aware rules, source only. Test files are excluded because the build
  // tsconfig excludes them, so `projectService` finds no project and they fail to
  // parse rather than lint.
  {
    ...tseslint.configs.base,
    files: ['apps/**/*.{ts,tsx}', 'shared/**/*.ts'],
    ignores: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      ...tseslint.configs.base.languageOptions,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Needs types. Catches `throw 'string'`, which defeats the repo's
      // `Object.assign(new Error(msg), { statusCode })` convention.
      '@typescript-eslint/only-throw-error': 'error',
      // Source only: an `any` in a test fixture is a deliberate shortcut, and
      // there are 97 of them. In shipped code it is a gap worth arguing about.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-useless-computed-key': 'error',
      // NOT enabled: `no-control-regex`. All 8 occurrences are ANSI-escape and NUL
      // handling in terminal-output parsers (runner-log, boot-probe, summary
      // reporter) — the control character is the whole point of the pattern.
      // NOT enabled: `no-require-imports`. Every occurrence is a `require()` inside
      // a `vi.mock` factory, which is the repo's established mocking pattern.
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // Warn, not error: the 6 current findings are real but each needs a
      // behaviour judgement, not a mechanical fix.
      'react-hooks/exhaustive-deps': 'warn',
      'react/no-danger': 'error',
    },
  },
  // A directive that suppresses nothing is the same rot as a stale allowlist
  // entry: it claims a rule is being managed when it isn't. This found 13.
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
)
