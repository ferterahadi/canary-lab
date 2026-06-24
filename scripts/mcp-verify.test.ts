import { describe, expect, it } from 'vitest'
import { classifyDoctorOutput, verifyMcpRegistration } from './mcp-verify'

describe('classifyDoctorOutput', () => {
  it('reports verified when doctor reaches the server', () => {
    const result = classifyDoctorOutput(0, 'Canary Lab MCP is reachable at http://127.0.0.1:7421/mcp\nTools: 13 listed')
    expect(result.status).toBe('verified')
  })

  it('reports server-down when the server is not reachable', () => {
    const result = classifyDoctorOutput(1, 'Canary Lab MCP is not reachable: ECONNREFUSED\nStart the UI first: canary-lab ui')
    expect(result.status).toBe('server-down')
  })

  it('reports broken when the command does not know the mcp subcommand', () => {
    expect(classifyDoctorOutput(1, 'Unknown command: mcp').status).toBe('broken')
  })

  it('reports broken on an unexpected failure', () => {
    expect(classifyDoctorOutput(127, 'command not found: node').status).toBe('broken')
  })
})

describe('verifyMcpRegistration', () => {
  it('probes the resolved command with `mcp doctor --no-autostart`', () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const result = verifyMcpRegistration(
      { command: '/usr/bin/node', args: ['/opt/cli.js', 'mcp', '--profile', 'lifecycle'] },
      (command, args) => { calls.push({ command, args }); return { exitCode: 0, output: 'reachable' } },
    )
    expect(calls).toEqual([{
      command: '/usr/bin/node',
      args: ['/opt/cli.js', 'mcp', 'doctor', '--profile', 'lifecycle', '--no-autostart'],
    }])
    expect(result.status).toBe('verified')
  })

  it('surfaces a broken registration from the runner output', () => {
    const result = verifyMcpRegistration(
      { command: 'npx', args: ['-y', 'canary-lab@latest', 'mcp'] },
      () => ({ exitCode: 1, output: 'Unknown command: mcp' }),
    )
    expect(result.status).toBe('broken')
  })
})
