import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDocsCollection } from '../../features/coverage/logic/coverage/docs-collection'
import { registerFeatureAuthoringTools } from './authoring-features'
import { captureTools } from './__fixtures__/tool-group-harness'

// Feature skeletons, feature docs, and the coverage reads a client needs before
// authoring.
//
// Real files in a tmpdir: every one of these writes into (or deletes out of) the
// user's features/ tree. Two behaviours are worth naming because they are easy
// to get backwards. `write_feature_doc` takes EXACTLY one of content/link_path —
// accepting both would silently pick one and lose the other. And an unexpected
// throw is deliberately RE-RAISED rather than returned as a tool error: only a
// missing feature is a normal answer, so a corrupt tree must not read to the
// agent as "this feature has no docs".

let tmpDir: string
let featuresDir: string
let logsDir: string

function harness(over: Record<string, unknown> = {}) {
  const published: unknown[] = []
  const tools = captureTools(registerFeatureAuthoringTools, {
    projectRoot: tmpDir,
    featuresDir,
    store: { logsDir },
    workspaceEvents: { publish: (e: unknown) => published.push(e) },
    ...over,
  })
  return { ...tools, published }
}

/** Creates the feature through the tool itself, which is how the tests get a
 *  skeleton that matches what the surface actually produces. */
async function createFeature(name = 'checkout'): Promise<void> {
  const { call } = harness()
  const out = await call('create_feature', { feature: name, description: 'd' })
  expect(out.ok).toBe(true)
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-authoring-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('create_feature', () => {
  it('scaffolds a skeleton on disk', async () => {
    const { call } = harness()

    const out = await call('create_feature', {
      feature: 'checkout', description: 'checkout flow', envs: ['local'],
      repos: [{ name: 'shop', localPath: '/repo/shop' }],
    })

    expect(out.ok).toBe(true)
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'))).toBe(true)
    // Nothing was captured, so no envset fields ride along.
    expect(out).not.toHaveProperty('captured')
  })

  it('refuses a name that already exists rather than overwriting it', async () => {
    await createFeature()
    const { text } = harness()

    expect(await text('create_feature', { feature: 'checkout' })).not.toBe('')
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'))).toBe(true)
  })

  it('captures declared env files alongside the skeleton', async () => {
    const repoDir = path.join(tmpDir, 'repo-shop')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'API_KEY=secret\n')
    const { call } = harness()

    const out = await call('create_feature', {
      feature: 'checkout', envs: ['local'],
      repos: [{ name: 'shop', localPath: repoDir }],
      envSources: [{ sourcePath: path.join(repoDir, '.env.local'), env: 'local', slot: 'shop.env' }],
    })

    expect(out).toHaveProperty('captured')
    expect(out).toHaveProperty('envsets')
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'envsets', 'local', 'shop.env'))).toBe(true)
    // Values are never echoed back.
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('reports a failed capture, having already made the skeleton', async () => {
    const { text } = harness()

    const out = await text('create_feature', {
      feature: 'checkout',
      envSources: [{ sourcePath: path.join(tmpDir, 'missing.env'), env: 'local', slot: 'x.env' }],
    })

    expect(out).toContain('source file not found')
    // The skeleton is real: the client should fix the source and capture again,
    // not re-create the feature.
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'))).toBe(true)
  })

  it('reports a filesystem failure instead of letting it escape', async () => {
    fs.chmodSync(featuresDir, 0o500)
    try {
      const { text } = harness()

      expect(await text('create_feature', { feature: 'checkout' })).toMatch(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(featuresDir, 0o700)
    }
  })
})

describe('write_feature_doc', () => {
  it('refuses both content and link_path together, and neither alone', async () => {
    await createFeature()
    const { text } = harness()
    const both = await text('write_feature_doc', {
      feature: 'checkout', relPath: 'notes.md', content: '# x', link_path: '/tmp/x.md',
    })
    const neither = await text('write_feature_doc', { feature: 'checkout', relPath: 'notes.md' })

    // Accepting both would silently pick one and lose the other.
    for (const out of [both, neither]) {
      expect(out).toBe('pass exactly one of content (write a doc) or link_path (link a local file)')
    }
  })

  it('writes a markdown doc into the feature docs dir', async () => {
    await createFeature()
    const { call } = harness()

    const out = await call('write_feature_doc', {
      feature: 'checkout', relPath: 'notes.md', content: '# Checkout\n',
    })

    expect(out).toMatchObject({ written: true, relativePath: 'docs/notes.md' })
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', 'notes.md'), 'utf8')).toBe('# Checkout\n')
  })

  it('requires a relPath alongside content', async () => {
    await createFeature()
    const { text } = harness()

    expect(await text('write_feature_doc', { feature: 'checkout', content: '# x' }))
      .toBe('relPath is required with content')
  })

  it('surfaces a rejected write', async () => {
    await createFeature()
    const { text } = harness()

    // Not markdown: written docs are .md/.markdown only.
    expect(await text('write_feature_doc', { feature: 'checkout', relPath: 'notes.txt', content: 'x' }))
      .not.toBe('')
  })

  it('links a local file in place, leaving the user\'s original as the live source', async () => {
    await createFeature()
    const source = path.join(tmpDir, 'prd.md')
    fs.writeFileSync(source, '# requirements\n')
    const { call } = harness()

    const out = await call('write_feature_doc', { feature: 'checkout', link_path: source })

    expect(out).toMatchObject({ written: true, linked: true })
    // Read through the link: editing the original must show up here.
    fs.writeFileSync(source, '# requirements v2\n')
    expect(fs.readFileSync(String(out.path), 'utf8')).toBe('# requirements v2\n')
  })

  it('honours an explicit relPath for a link', async () => {
    await createFeature()
    const source = path.join(tmpDir, 'prd.md')
    fs.writeFileSync(source, '# requirements\n')
    const { call } = harness()

    const out = await call('write_feature_doc', {
      feature: 'checkout', link_path: source, relPath: 'sources/upstream.md',
    })

    expect(out).toMatchObject({ relativePath: 'docs/sources/upstream.md' })
  })

  it('surfaces a rejected link', async () => {
    await createFeature()
    const { text } = harness()

    expect(await text('write_feature_doc', { feature: 'checkout', link_path: path.join(tmpDir, 'missing.md') }))
      .not.toBe('')
  })
})

describe('delete_feature_doc', () => {
  it('removes a source doc', async () => {
    await createFeature()
    const { call } = harness()
    await call('write_feature_doc', { feature: 'checkout', relPath: 'notes.md', content: '# x' })

    const out = await call('delete_feature_doc', { feature: 'checkout', relPath: 'notes.md' })

    expect(out).toEqual({ deleted: true, relativePath: 'docs/notes.md' })
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'docs', 'notes.md'))).toBe(false)
  })

  it('surfaces a refused deletion', async () => {
    await createFeature()
    const { text } = harness()

    // Generated artifacts are canary's, not the client's, to delete.
    expect(await text('delete_feature_doc', { feature: 'checkout', relPath: '_prd-summary.md' }))
      .not.toBe('')
  })
})

describe('get_feature_coverage', () => {
  it('attaches the recovery step when the ledger is blocked', async () => {
    await createFeature()
    const { call } = harness()

    const out = await call('get_feature_coverage', { feature: 'checkout' })

    // A blocked ledger with no `next` is what makes an agent hedge instead of
    // acting; the no-source-doc case is the one that needs the human.
    expect((out.state as { coverage: string }).coverage).toBe('blocked')
    expect(String(out.next)).not.toBe('')
  })

  it('returns the ledger as-is once a summary exists', async () => {
    await createFeature()
    // A summary on disk is what unblocks the ledger; with one, the tool must
    // return the real numbers rather than a recovery instruction.
    const featureDir = path.join(featuresDir, 'checkout')
    const docs = path.join(featureDir, 'docs')
    fs.mkdirSync(docs, { recursive: true })
    fs.writeFileSync(path.join(docs, 'prd.md'), '# a shopper can pay\n')
    // The stored docsHash has to MATCH the live one or the summary reads as
    // drifted, which blocks coverage again. Taken from the shipped reader rather
    // than re-deriving the hash here.
    fs.writeFileSync(path.join(docs, '_prd-summary.json'), JSON.stringify({
      requirements: [{ id: 'R1', title: 'pays', text: 'a shopper can pay', pathTypes: ['happy'] }],
      docsHash: readDocsCollection(featureDir).docsHash,
      sourceDocs: ['prd.md'],
      generatedAt: '2026-08-01T00:00:00.000Z',
    }))
    const { call } = harness()

    const out = await call('get_feature_coverage', { feature: 'checkout' })

    expect((out.state as { coverage: string }).coverage).not.toBe('blocked')
    expect(out).not.toHaveProperty('next')
    // One requirement, no test claiming it: untested, so nothing is covered.
    expect(out.requirements).toMatchObject([{ gapType: 'untested' }])
    expect(out.coveragePct).toBe(0)
  })

  it('reports an unknown feature by name', async () => {
    const { text } = harness()

    expect(await text('get_feature_coverage', { feature: 'ghost' })).toContain('ghost')
  })
})

describe('list_feature_docs', () => {
  it('lists the source docs the PRD summary would be built from', async () => {
    await createFeature()
    const { call } = harness()
    await call('write_feature_doc', { feature: 'checkout', relPath: 'notes.md', content: '# x' })

    const out = await call('list_feature_docs', { feature: 'checkout' })

    expect(out.sourceDocCount).toBe(1)
  })

  it('reports an unknown feature by name', async () => {
    const { text } = harness()

    expect(await text('list_feature_docs', { feature: 'ghost' })).toContain('ghost')
  })
})

describe('clear_prd_summary', () => {
  it('resets the feature and announces both surfaces that changed', async () => {
    await createFeature()
    const { call, published } = harness()

    const out = await call('clear_prd_summary', { feature: 'checkout' })

    expect(out).toHaveProperty('removed')
    expect(out).toHaveProperty('untagged')
    // Two surfaces move: the coverage badge and the specs (tags were stripped).
    expect(published).toEqual([
      { type: 'coverage-changed', feature: 'checkout' },
      { type: 'tests-changed', feature: 'checkout' },
    ])
  })

  it('reports an unknown feature by name', async () => {
    const { text } = harness()

    expect(await text('clear_prd_summary', { feature: 'ghost' })).toContain('ghost')
  })
})

describe('an unexpected failure is re-raised, not reported as a normal answer', () => {
  /** Replaces the docs directory with a FILE, so every read of it hits ENOTDIR —
   *  neither "feature missing" nor an empty result. */
  function breakDocsDir(feature = 'checkout'): void {
    const docs = path.join(featuresDir, feature, 'docs')
    fs.rmSync(docs, { recursive: true, force: true })
    fs.writeFileSync(docs, 'not a directory')
  }

  it('lets a docs listing blow up rather than answering "no docs"', async () => {
    await createFeature()
    breakDocsDir()
    const { text } = harness()

    // Returning a tool error here would read to the agent as a feature with no
    // source material, which is the state that makes it invent a PRD.
    await expect(text('list_feature_docs', { feature: 'checkout' })).rejects.toThrow(/ENOTDIR/)
  })

  it('lets a coverage read blow up rather than answering "nothing to cover"', async () => {
    await createFeature()
    breakDocsDir()
    const { text } = harness()

    await expect(text('get_feature_coverage', { feature: 'checkout' })).rejects.toThrow(/ENOTDIR/)
  })

  it('lets a failed reset blow up rather than reporting a reset that did not happen', async () => {
    await createFeature()
    const e2e = path.join(featuresDir, 'checkout', 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    const spec = path.join(e2e, 'checkout.spec.ts')
    fs.writeFileSync(
      spec,
      "import { test } from 'canary-lab/feature-support/log-marker-fixture'\ntest('pays', { tag: ['@req-R1'] }, async () => {})\n",
    )
    // A read-only SPEC file: the tag strip has something to write and cannot.
    // (A read-only directory would not do it — POSIX lets you rewrite an
    // existing file's contents inside one.)
    fs.chmodSync(spec, 0o400)
    try {
      const { text, published } = harness()

      await expect(text('clear_prd_summary', { feature: 'checkout' })).rejects.toThrow(/EACCES|permission denied/i)
      // And nothing is announced for a reset that did not land.
      expect(published).toEqual([])
    } finally {
      fs.chmodSync(spec, 0o600)
    }
  })
})
