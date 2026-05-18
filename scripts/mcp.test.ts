import { describe, expect, it } from 'vitest'
import path from 'path'
import { Writable } from 'stream'
import { createServer } from '../apps/web-server/server'
import type { PtyFactory } from '../apps/web-server/lib/runtime/pty-spawner'
import { bridge, doctor, main } from './mcp'

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

class BufferWritable extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString())
    callback()
  }
  text(): string {
    return this.chunks.join('')
  }
}

describe('canary-lab mcp', () => {
  it('doctor verifies a running UI MCP server and wait_for_heal_task', async () => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const stdout = new BufferWritable()
    const stderr = new BufferWritable()
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await expect(doctor(`${address}/mcp`, { stdout, stderr })).resolves.toBe(true)
      expect(stdout.text()).toContain('Canary Lab MCP is reachable')
      expect(stderr.text()).toBe('')
    } finally {
      await app.close()
    }
  })

  it('bridge reports a clear error when the UI MCP server is not reachable', async () => {
    const stderr = new BufferWritable()
    await expect(bridge('http://127.0.0.1:9/mcp', { stderr })).resolves.toBe(false)
    expect(stderr.text()).toContain('Start the UI first: canary-lab ui')
  })

  it('routes doctor through main and exits 0 on success', async () => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const exits: number[] = []
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await main(['doctor', '--url', `${address}/mcp`], { exit: (code) => { exits.push(code) } })
      expect(exits).toEqual([0])
    } finally {
      await app.close()
    }
  })
})
