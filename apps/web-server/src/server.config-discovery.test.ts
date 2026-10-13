import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decode } from '@toon-format/toon'
import { createServer } from './server'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('canary-config-discovery-')

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('keeps REST config reads and connected-agent discovery consistent as candidates change', async () => {
  const root = tempDir()
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'shop')
  fs.mkdirSync(featureDir, { recursive: true })
  const source = (description: string) => `exports.config = { name: 'shop', description: '${description}', featureDir: __dirname, envs: ['local'], repos: [] }\n`
  const write = (format: string, description = format) => fs.writeFileSync(path.join(featureDir, `feature.config.${format}`), source(description))
  write('ts')
  const ptyFactory = vi.fn(() => { throw new Error('Discovery verification must not spawn agents') })
  const { app } = await createServer({ projectRoot: root, featuresDir, logsDir: path.join(root, 'logs'), ptyFactory })
  cleanups.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'discovery-observer', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  cleanups.push(() => client.close())
  const list = async () => {
    const result = await client.callTool({ name: 'list_features', arguments: {} })
    expect(result.isError).not.toBe(true)
    if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text response')
    return decode(result.content[0].text)
  }
  const check = async (format: string, description = format) => {
    const response = await app.inject('/api/features/shop/config')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ path: path.join(featureDir, `feature.config.${format}`), content: source(description), format })
    expect(await list()).toEqual([{ name: 'shop', description, envs: 'local', repos: '' }])
  }
  await check('ts')
  write('js')
  await check('js')
  write('cjs')
  await check('cjs')
  write('cjs', 'rewritten')
  await check('cjs', 'rewritten')
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'throw new Error("invalid first candidate")')
  const refused = await app.inject('/api/features/shop/config')
  expect(refused.statusCode).toBe(404)
  expect(refused.json()).toEqual({ error: 'feature not found' })
  expect(await list()).toEqual([])
  for (const [removed, selected] of [['cjs', 'js'], ['js', 'ts']]) {
    fs.unlinkSync(path.join(featureDir, `feature.config.${removed}`))
    await check(selected)
  }
  expect(ptyFactory).not.toHaveBeenCalled()
})
