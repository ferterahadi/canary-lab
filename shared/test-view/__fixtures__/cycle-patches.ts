// Shaped like the patches a repair cycle persists (`git diff <ref>` per
// snapshot tree, each under its `# repo:` key), with neutral paths and code.

/** Two modified files under one snapshot key. The second hunk of `pricing.ts`
 * carries a function-context trailer and a source line that begins with `---`,
 * which only hunk counting tells apart from a file header. */
export const TWO_FILE_CYCLE = [
  '# repo: /workspace/features/alpha',
  'diff --git a/src/pricing.ts b/src/pricing.ts',
  'index 33dd6fb..ff7213c 100644',
  '--- a/src/pricing.ts',
  '+++ b/src/pricing.ts',
  '@@ -1,3 +1,3 @@',
  ' export const RATE = 0.2',
  '-export const total = (p: number) => Math.round(p * 0.95)',
  '+export const total = (p: number) => Math.round(p * 0.9)',
  " export const label = 'total'",
  '@@ -40,2 +40,4 @@ export function price(p: number) {',
  '   return p * RATE',
  '+  // rounded by caller',
  '+--- divider',
  ' }',
  'diff --git a/e2e/support/staging.ts b/e2e/support/staging.ts',
  'index 49dd8db..ada4101 100644',
  '--- a/e2e/support/staging.ts',
  '+++ b/e2e/support/staging.ts',
  '@@ -5,2 +5,2 @@',
  "-export const BASE = 'http://127.0.0.1:4000'",
  "+export const BASE = 'http://127.0.0.1:4100'",
  ' export const TIMEOUT = 5_000',
  '',
].join('\n')

export const ADDED_FILE = [
  '# feature config: /workspace/features/beta',
  'diff --git a/e2e/new.spec.ts b/e2e/new.spec.ts',
  'new file mode 100644',
  'index 0000000..7b9a9f9',
  '--- /dev/null',
  '+++ b/e2e/new.spec.ts',
  '@@ -0,0 +1,2 @@',
  "+import { test } from '@playwright/test'",
  "+test('works', () => {})",
  '',
].join('\n')

export const DELETED_FILE = [
  'diff --git a/e2e/old.spec.ts b/e2e/old.spec.ts',
  'deleted file mode 100644',
  'index 7b9a9f9..0000000',
  '--- a/e2e/old.spec.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  "-import { test } from '@playwright/test'",
  "-test('works', () => {})",
  '',
].join('\n')

export const RENAMES = [
  'diff --git a/src/a.ts b/src/b.ts',
  'similarity index 100%',
  'rename from src/a.ts',
  'rename to src/b.ts',
  'diff --git a/src/c.ts b/src/d.ts',
  'similarity index 90%',
  'rename from src/c.ts',
  'rename to src/d.ts',
  'index 1111111..2222222 100644',
  '--- a/src/c.ts',
  '+++ b/src/d.ts',
  '@@ -1 +1 @@',
  '-export const c = 1',
  '+export const d = 1',
  '',
].join('\n')

/** Binary literal lines can begin with `-` or `+`; none of them is a row. */
export const BINARY_FILES = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 3333333..4444444 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/assets/icon.png b/assets/icon.png',
  'index 5555555..6666666 100644',
  'GIT binary patch',
  'literal 4',
  '-Lb+n3',
  '',
].join('\n')

export const NO_NEWLINE_AT_END = [
  'diff --git a/src/one.ts b/src/one.ts',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1 +1 @@',
  '-export const one = 1',
  '\\ No newline at end of file',
  '+export const one = 2',
  'diff --git a/src/two.ts b/src/two.ts',
  '--- a/src/two.ts',
  '+++ b/src/two.ts',
  '@@ -1,2 +1,2 @@',
  '-export const two = 1',
  '+export const two = 2',
  '\\ No newline at end of file',
  ' // end',
  'diff --git a/src/three.ts b/src/three.ts',
  '--- a/src/three.ts',
  '+++ b/src/three.ts',
  '@@ -1,2 +1,3 @@',
  '+// header',
  ' export const three = 3',
  ' // end',
  '\\ No newline at end of file',
  '',
].join('\n')

export const LINE_ENDINGS = [
  'diff --git a/win.ts b/win.ts',
  '--- a/win.ts',
  '+++ b/win.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1\r',
  '-const b = 1\r',
  '+const b = 2\r',
  'diff --git a/mixed.ts b/mixed.ts',
  '--- a/mixed.ts',
  '+++ b/mixed.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1\r',
  '-const b = 1',
  '+const b = 2',
  '',
].join('\n')

/** The journal's inline block: no `diff --git`, one file after another. */
export const HEADERLESS_FRAGMENT = [
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1 +1 @@',
  '-x = 1',
  '+x = 2',
  '--- /dev/null',
  '+++ b/src/y.ts',
  '@@ -0,0 +1 @@',
  '+y = 1',
  '--- a/src/z.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-z = 1',
  '',
].join('\n')

/** A pure insertion after line 3, then a second hunk past a hidden stretch. */
export const ZERO_COUNT_HUNK = [
  'diff --git a/src/list.ts b/src/list.ts',
  '--- a/src/list.ts',
  '+++ b/src/list.ts',
  '@@ -3,0 +4,2 @@',
  "+  'four',",
  "+  'five',",
  '@@ -10 +12 @@',
  "-  'ten',",
  "+  'twelve',",
  '',
].join('\n')
