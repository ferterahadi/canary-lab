import fs from 'fs'
import path from 'path'

type Entries = Record<string, Record<string, unknown>>

// Only the subprocess boundary is fake; Claude's configuration readback uses a
// real temporary file, so a successful add must actually persist the new entry.
export function fakeMcpClients(homeDir: string, initial: { codex?: Entries; claude?: Entries; available?: string[] } = {}) {
  const codex = { ...initial.codex }
  const available = initial.available ?? ['codex', 'claude']
  const claudeFile = path.join(homeDir, '.claude.json')
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: initial.claude ?? {}, preferences: { keep: true } }))
  return (command: string, args: string[]) => {
    if (command === 'which' || command === 'where') {
      if (!available.includes(args[0])) throw new Error('CLI not found')
      return Buffer.from(`/test/bin/${args[0]}`)
    }
    if (!available.includes(command)) throw new Error('CLI not found')
    if (command === 'codex') {
      const name = args[2]
      if (args[1] === 'get') {
        if (!codex[name]) throw new Error(`No MCP server named '${name}' found`)
        return JSON.stringify({ name, enabled: true, ...codex[name] })
      }
      if (args[1] === 'remove') delete codex[name]
      if (args[1] === 'add') {
        const split = args.indexOf('--')
        const env: Record<string, string> = {}
        for (let i = 3; i < split; i += 2) {
          const value = args[i + 1]
          const equal = value.indexOf('=')
          env[value.slice(0, equal)] = value.slice(equal + 1)
        }
        codex[name] = { transport: { type: 'stdio', command: args[split + 1], args: args.slice(split + 2), env } }
      }
    } else {
      const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'))
      if (args[1] === 'remove') delete config.mcpServers[args[2]]
      if (args[1] === 'add-json') config.mcpServers[args[4]] = JSON.parse(args[5])
      fs.writeFileSync(claudeFile, JSON.stringify(config))
    }
    return Buffer.from('')
  }
}
