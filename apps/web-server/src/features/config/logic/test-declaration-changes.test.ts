import { expect, it } from 'vitest'
import { compareTestDeclarations, meaningfulChangeLines, pairTestDeclarations } from './test-declaration-changes'
import { extractTestMetadataFromSource } from '../../../shared/ast-extractor'

const compare = (before: string, after: string) => {
  const result = compareTestDeclarations([{ file: 'e2e/a.spec.ts', before, after }])
  expect(result.state).toBe('ready')
  if (result.state !== 'ready') throw new Error('Expected a complete comparison')
  return result
}
it('highlights only changed statements when tags, quotes and line wrapping also change', async () => {
  const before = `test('same', { tag: '@old' }, () => {
    const phone = graph('phone', { fields: 'id,status' });
    expect(phone.id).toBe(id); expect(phone.status).toBe('CONNECTED');
    expect(phone.ready).toBe(false);
  })`
  const after = `test('same', { tag: ['@old', '@new'] }, () => {
    const phone = graph("phone", {
      fields: "id,status",
    });
    expect(phone.id).toBe(id);
    expect(phone.status).toBe("CONNECTED");
    expect(phone.ready).toBe(true);
  })`
  const pairs = pairTestDeclarations(extractTestMetadataFromSource('a.spec.ts', before).tests, extractTestMetadataFromSource('a.spec.ts', after).tests)
  const edits = await meaningfulChangeLines(pairs)
  expect(edits).toMatchObject({ before: [4], after: [7] })
  expect(edits.alignment).toContainEqual({ before: { line: 3, endLine: 3 }, after: { line: 5, endLine: 6 } })
  const unchanged = after.replace('toBe(true)', 'toBe(false)')
  expect(await meaningfulChangeLines(pairTestDeclarations(extractTestMetadataFromSource('a.spec.ts', before).tests, extractTestMetadataFromSource('a.spec.ts', unchanged).tests))).toMatchObject({ before: [], after: [] })
})
it('counts entire declarations once, excluding imports, hooks, steps and setup', () => {
  const source = `import { test } from '@playwright/test'
  test.beforeEach(async () => { await setup() })
  test.describe('suite', () => {
    test('one', async () => { await test.step('step', async () => {}) })
    test.skip('two', async () => {})
  })`
  expect(compare('', source).changes.added.map((test) => test.name)).toEqual(['one', 'two'])
  const setupOnly = compare(source, source.replace("'@playwright/test'", "'./fixture'"))
  expect(setupOnly.changes).toEqual({ added: [], changed: [], removed: [] })
  expect(setupOnly.differences).toHaveLength(0)
})
it('counts a parameterized declaration once regardless of runtime cases', () => {
  const source = "for (const id of ['a', 'b', 'c']) { test(`case ${id}`, async () => { await work(id) }) }"
  expect(compare('', source).changes.added).toHaveLength(1)
  expect(compare(source, source.replace("'a', 'b', 'c'", "'a', 'b', 'c', 'd'")).changes).toEqual({ added: [], changed: [], removed: [] })
})
it('distinguishes content edits, additions and removals without counting line moves', () => {
  const before = "test('kept', () => {})\ntest('edit', () => { expect(value).toBe(1) })\ntest('gone', () => { oldWork() })"
  const after = "\n\ntest('kept', () => {})\ntest('edit', () => { expect(value).toBe(2) })\ntest('new', () => { newWork() })"
  const { changes } = compare(before, after)
  expect(changes.added).toEqual([{ file: 'e2e/a.spec.ts', name: 'new', line: 5, endLine: 5 }])
  expect(changes.changed.map((test) => test.name)).toEqual(['edit'])
  expect(changes.removed.map((test) => test.name)).toEqual(['gone'])
})
it.each([
  "test('same', { tag: ['@req-R1', '@req-R2'] }, async ({ page }) => { await page.goto('/'); expect(value).toBe(1) })",
  "test('same', async ({ page }) => { await page.goto('/'); expect(value).toBe(1) })",
  "test(\"same\", { tag: '@req-R1' }, async ({ page }) => {\n // explanation\n await page.goto(\"/\");\n expect(value).toBe(1);\n})",
])('excludes tag-only and presentation-only edits from counts and highlights: %s', (after) => {
  const before = "test('same', { tag: '@req-R1' }, async ({ page }) => { await page.goto('/'); expect(value).toBe(1) })"
  expect(compare(before, after)).toMatchObject({ changes: { added: [], changed: [], removed: [] }, differences: [] })
})
it('counts an unambiguous title-only edit as one changed test and retains both locations', () => {
  const before = "test('old title', () => { expect(value).toBe(1) })"
  const { changes } = compare(before, "\n\n" + before.replace('old title', 'new title'))
  expect(changes).toEqual({ added: [], removed: [], changed: [{ file: 'e2e/a.spec.ts', name: 'new title', line: 3, endLine: 3, previous: { name: 'old title', line: 1, endLine: 1 } }] })
})
it('pairs the deployed-to-local rename despite added setup and checks', () => {
  const before = `test('The deployed merchant connection matches the real Meta phone and template account', () => {
    deployment();
    const phone = graph('phone');
    expect(phone.id).toBe(id);
    expect(phone.status).toBe('CONNECTED');
    const server = cns('server');
    expect(server).not.toHaveProperty('token');
  })`
  const after = `test.beforeEach(() => { bootstrap() });\n` + before.replace('deployed merchant', 'local merchant').replace('deployment()', 'localCandidate()').replace("expect(server).not.toHaveProperty('token');", "expect(server).not.toHaveProperty('token');\n expect(server.ready).toBe(true);")
  const { changes } = compare(before, after)
  expect(changes.added).toEqual([])
  expect(changes.removed).toEqual([])
  expect(changes.changed).toHaveLength(1)
  expect(changes.changed[0].previous?.name).toContain('deployed merchant')
})
it('does not guess a rename between ambiguous identical bodies', () => {
  const { changes } = compare("test('a', () => { work() })\ntest('b', () => { work() })", "test('c', () => { work() })\ntest('d', () => { work() })")
  expect(changes.changed).toEqual([])
  expect(changes.added).toHaveLength(2)
  expect(changes.removed).toHaveLength(2)
})
it.each([
  ["test('same', () => { send({ tag: 'old' }) })", "test('same', () => { send({ tag: 'new' }) })"],
  ["test('same', async ({ page }) => { work() })", "test.skip('same', async ({ page }) => { work() })"],
  ["test('same', async ({ page }) => { work() })", "test('same', async ({ request }) => { work() })"],
  ["test('same', () => { const value = 'a b' })", "test('same', () => { const value = 'a  b' })"],
  ["test('same', () => { const value = 1 })", "test('same', () => { let value = 1 })"],
])('keeps executable edits meaningful: %s', (before, after) => {
  expect(compare(before, after).changes.changed).toHaveLength(1)
})
it('preserves duplicate declarations when an earlier duplicate is inserted', () => {
  const before = "test('same', () => { a() })\ntest('same', () => { b() })"
  const { changes } = compare(before, "test('same', () => { newWork() })\n" + before)
  expect(changes.added.map((test) => test.line)).toEqual([1])
  expect(changes.changed).toEqual([])
})
it('does not match declarations in different files or report parse failures as deletions', () => {
  const source = "test('same', () => {})"
  const result = compareTestDeclarations([{ file: 'old.spec.ts', before: source, after: '' }, { file: 'new.spec.ts', before: '', after: source }])
  expect(result).toMatchObject({ state: 'ready', changes: { added: [{ file: 'new.spec.ts' }], removed: [{ file: 'old.spec.ts' }] } })
  const invalid = compareTestDeclarations([{ file: 'deep.spec.ts', before: source, after: `test('deep', () => { const a = ${'('.repeat(2000)}x${')'.repeat(2000)} })` }])
  expect(invalid).toMatchObject({ state: 'unavailable', reasons: [expect.stringContaining('deep.spec.ts')] })
  expect(invalid).not.toHaveProperty('changes')
})
// A body passed by reference — a shared flow the spec hands to `test` instead of
// an inline callback. There is no callback to look inside, so the declaration is
// one unit whose range has to span the whole call, not stop at a callback that
// isn't there.
it('treats a declaration whose body is passed by reference as one whole unit', async () => {
  const before = "test('same',\n  sharedFlow)"
  const after = before.replace('sharedFlow', 'replacementFlow')
  expect(compare(before, after).changes.changed).toHaveLength(1)
  const edits = await meaningfulChangeLines(pairTestDeclarations(extractTestMetadataFromSource('a.spec.ts', before).tests, extractTestMetadataFromSource('a.spec.ts', after).tests))
  expect(edits).toMatchObject({ before: [1, 2], after: [1, 2] })
  expect(edits.alignment).toEqual([{ before: { line: 1, endLine: 2 }, after: { line: 1, endLine: 2 } }])
})
// The two callback spellings that are not an arrow with a block. If either were
// skipped the body would contribute no statements, and the whole declaration —
// not the one edited line — would light up as changed.
it.each([
  ['a function expression', "it('same', function () {\n  a()\n  expect(value).toBe(1)\n})", 3],
  ['a concise arrow body', "test('same', async () =>\n  expect(value).toBe(1))", 2],
])('locates the edit inside %s', async (_label, before, line) => {
  const after = before.replace('toBe(1)', 'toBe(2)')
  expect(compare(before, after).changes.changed).toHaveLength(1)
  const edits = await meaningfulChangeLines(pairTestDeclarations(extractTestMetadataFromSource('a.spec.ts', before).tests, extractTestMetadataFromSource('a.spec.ts', after).tests))
  expect(edits).toMatchObject({ before: [line], after: [line] })
})
// A details object assembled from a shared constant. `tag` and `annotation` are
// registration metadata and drop out, but a spread hides what it contributes, so
// whatever survives the drop keeps the object inside the comparison.
it('keeps a details object that carries more than tags', () => {
  const source = "test('same', { ...BASE, tag: '@req-R1' }, () => { work() })"
  expect(compare(source, source.replace('@req-R1', '@req-R2')).changes).toEqual({ added: [], changed: [], removed: [] })
  expect(compare(source, source.replace('...BASE', '...OTHER')).changes.changed).toHaveLength(1)
})
// A rename is inferred from shared title vocabulary plus shared code. A title
// made only of symbols contributes no words at all, so there is no vocabulary to
// share and position alone must not become the rename evidence.
it('never guesses a rename between symbol-only titles over unrelated bodies', () => {
  const { changes } = compare("test('🛒', () => { addToCart() })", "test('🧾', () => { openReceipt() })")
  expect(changes.changed).toEqual([])
  expect(changes.added.map((test) => test.name)).toEqual(['🧾'])
  expect(changes.removed.map((test) => test.name)).toEqual(['🛒'])
})
// An insertion can land on a line that already holds a matched statement, and it
// exists on one side only. The alignment stays one row per source line pair: the
// one-sided row must neither invent a range on the empty side nor push the
// matched statement out of the row its own line belongs to.
it('keeps one alignment row per source line when insertions share lines with matches', async () => {
  const before = "test('same', () => {\n  a()\n  b(); c()\n})"
  const after = "test('same', () => {\n  a(); x()\n  y(); b(); c()\n})"
  const edits = await meaningfulChangeLines(pairTestDeclarations(extractTestMetadataFromSource('a.spec.ts', before).tests, extractTestMetadataFromSource('a.spec.ts', after).tests))
  expect(edits).toMatchObject({ before: [], after: [2, 3] })
  expect(edits.alignment).toEqual([
    { before: { line: 1, endLine: 1 }, after: { line: 1, endLine: 1 } },
    { before: { line: 2, endLine: 2 }, after: { line: 2, endLine: 2 } },
    { before: { line: 3, endLine: 3 }, after: { line: 3, endLine: 3 } },
  ])
})
