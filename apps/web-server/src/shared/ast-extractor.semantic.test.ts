import { describe, expect, it } from 'vitest'
import { extractTestsFromSource } from './ast-extractor'

describe('AST extractor structured semantic English', () => {
  it('carries proven Playwright fixture, assertion, and error-flow semantics into readable nodes', () => {
    const source = `import { expect, test } from '@playwright/test'

test('gateway health', async ({ request }) => {
  const res = await request.get(\`${'${GATEWAY_URL}'}/\`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.status).toBe("OK")
  try {
    await request.post('/audit')
  } catch (error) {
    throw error
  }
})`
    const result = extractTestsFromSource('/workspace/gateway.spec.ts', source)
    const nodes = result.tests[0].readable.nodes

    expect(nodes.slice(0, 4).map((node) => node.english?.text)).toEqual([
      'Await `request.get(`${GATEWAY_URL}/`)` and store the result in constant `res`.',
      'Check that `res.status` equals `200`.',
      'Await `res.json()` and store the result in constant `body`.',
      'Check that `body.status` equals `"OK"`.',
    ])
    expect(nodes[0].english?.semanticCategories).toEqual([
      'external-api',
      'declaration',
      'async',
      'function-call',
    ])
    expect(nodes[2].english?.semanticCategories).not.toContain('external-api')

    const tryNode = nodes[4]
    expect(tryNode).toMatchObject({
      kind: 'group',
      english: {
        text: 'Try:',
        semanticCategories: ['error-control-flow'],
      },
    })
    if (tryNode.kind !== 'group') throw new Error('Expected try group')
    expect(tryNode.children[0].english?.semanticCategories).toContain('external-api')
    expect(tryNode.children[1]).toMatchObject({
      kind: 'group',
      controlRole: 'catch',
      english: { text: 'Catch error `error`:' },
    })
  })

  it('uses project module configuration as evidence and ignores ambiguous method names', () => {
    const source = `import api from '@company/api-client'
import store from '@company/database'
import { test } from '@playwright/test'

test('configured clients', async () => {
  await api.get('/health')
  await store.findMany()
  await unrelated.findMany()
})`
    const result = extractTestsFromSource('/workspace/configured.spec.ts', source, {
      apiClients: ['@company/api-client'],
      databaseClients: ['@company/database'],
    })
    const categories = result.tests[0].readable.nodes.map((node) => node.english?.semanticCategories)
    expect(categories).toEqual([
      ['external-api', 'async', 'function-call'],
      ['database', 'async', 'function-call'],
      ['async', 'function-call'],
    ])
  })
})
