import { checked } from './files'

const codexBase = ['--disable', 'apps', '--disable', 'plugins', '--disable', 'memories', '--disable', 'hooks', '-c', 'project_doc_max_bytes=0']

function servers(raw: string): Array<{ name: string; enabled: boolean }> {
  const rows: unknown = JSON.parse(raw)
  if (!Array.isArray(rows) || rows.some((row) => typeof row.name !== 'string' || typeof row.enabled !== 'boolean')) throw new Error('Unexpected Codex MCP inventory')
  return rows
}

// Codex merges config tables. An empty mcp_servers table does not disable any
// inherited entries: freeze an explicit override for every discovered server.
export async function resolveCodexToolArgs(cwd: string, executable = 'codex'): Promise<string[]> {
  const inventory = servers(await checked(executable, [...codexBase, 'mcp', 'list', '--json'], cwd))
  if (inventory.some(({ name }) => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('Cannot safely address an inherited Codex MCP server name')
  const args = [...codexBase, ...inventory.sort((a, b) => a.name.localeCompare(b.name)).flatMap(({ name }) => ['-c', `mcp_servers.${name}.enabled=false`])]
  await verifyCodexToolArgs(args, cwd, executable)
  return args
}

export async function verifyCodexToolArgs(args: string[] | undefined, cwd: string, executable = 'codex'): Promise<void> {
  if (!args?.length) throw new Error('Study has no verified Codex tool policy; prepare a new campaign')
  const active = servers(await checked(executable, [...args, 'mcp', 'list', '--json'], cwd)).filter((server) => server.enabled)
  if (active.length) throw new Error(`Inherited Codex MCP servers remain enabled: ${active.map((server) => server.name).join(', ')}`)
}
