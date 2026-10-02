import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFeatureConfig } from '../../../shared/config-ast'
import { listEnvFolders, readEnvsetsConfig, syncEnvsInConfig, writeEnvsetsConfig } from './envset-config'

let dir: string
let envsets: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-envset-config-'))
  envsets = path.join(dir, 'envsets')
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

it('treats missing metadata as optional and preserves unknown fields on round trip', () => {
  expect(readEnvsetsConfig(envsets)).toEqual({})
  const config = { slots: { 'app.env': { target: '/workspace/app/.env' } }, extension: { retained: true } }
  writeEnvsetsConfig(envsets, config)
  expect(readEnvsetsConfig(envsets)).toEqual(config)
  expect(fs.readFileSync(path.join(envsets, 'envsets.config.json'), 'utf8')).toBe(JSON.stringify(config, null, 2) + '\n')
})

it.each(['{SECRET=private', 'null', '[]', '"private"', '42', 'true'])('rejects invalid metadata %s without exposing contents or changing bytes', (source) => {
  fs.mkdirSync(envsets)
  const file = path.join(envsets, 'envsets.config.json')
  fs.writeFileSync(file, source)
  expect(() => readEnvsetsConfig(envsets)).toThrow(expect.objectContaining({
    message: 'envsets.config.json must contain a valid JSON object', statusCode: 409,
  }))
  expect(fs.readFileSync(file, 'utf8')).toBe(source)
})

it('does not impose nested schema validation on object metadata', () => {
  fs.mkdirSync(envsets)
  fs.writeFileSync(path.join(envsets, 'envsets.config.json'), '{"feature":null,"custom":[1]}')
  expect(readEnvsetsConfig(envsets)).toEqual({ feature: null, custom: [1] })
})

it('propagates filesystem read and write failures', () => {
  fs.mkdirSync(path.join(envsets, 'envsets.config.json'), { recursive: true })
  expect(() => readEnvsetsConfig(envsets)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  expect(() => writeEnvsetsConfig(envsets, {})).toThrow(expect.objectContaining({ code: 'EISDIR' }))
})

it('derives sorted environments only from directories and permits an empty workspace', () => {
  expect(listEnvFolders(dir)).toEqual([])
  fs.mkdirSync(path.join(envsets, 'staging'), { recursive: true })
  fs.mkdirSync(path.join(envsets, 'local'))
  fs.writeFileSync(path.join(envsets, 'ignore.env'), '')
  expect(listEnvFolders(dir)).toEqual(['local', 'staging'])
  expect(() => syncEnvsInConfig(dir)).not.toThrow()
})

it('removes stale declarations, preserves comments, and skips unchanged config writes', () => {
  const file = path.join(dir, 'feature.config.cjs')
  fs.writeFileSync(file, "// Keep this explanation\nmodule.exports = { config: { name: 'suite', envs: ['stale'] } }\n")
  fs.mkdirSync(path.join(envsets, 'staging'), { recursive: true })
  fs.mkdirSync(path.join(envsets, 'local'))
  syncEnvsInConfig(dir)
  const source = fs.readFileSync(file, 'utf8')
  expect(source).toContain('// Keep this explanation')
  expect(readFeatureConfig(source).value).toMatchObject({ name: 'suite', envs: ['local', 'staging'] })
  const write = vi.spyOn(fs, 'writeFileSync')
  syncEnvsInConfig(dir)
  expect(write).not.toHaveBeenCalled()
  write.mockRestore()
  fs.rmSync(envsets, { recursive: true })
  syncEnvsInConfig(dir)
  expect(readFeatureConfig(fs.readFileSync(file, 'utf8')).value).toMatchObject({ envs: [] })
})
