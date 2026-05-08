import fs from 'fs'
import path from 'path'

export const PERSONAL_WIKI_START = '<!-- personal-wiki:start -->'
export const PERSONAL_WIKI_END = '<!-- personal-wiki:end -->'

const MANAGED_START = '<!-- managed:canary-lab:start -->'
const MANAGED_END = '<!-- managed:canary-lab:end -->'

const LEGACY_SIGNATURES: Record<string, string> = {
  'CLAUDE.md': '# Canary Lab Project Notes',
  'AGENTS.md': '# Canary Lab Agent Guide',
}

const AGENT_DOCS = ['CLAUDE.md', 'AGENTS.md']

export function renderPersonalWikiMap(personalWikiPath?: string | null): string {
  const wikiPath = personalWikiPath?.trim()
  if (!wikiPath) return ''
  return `- \`${wikiPath}\` — Karpathy-style personal wiki with distilled prior agent conversations and debugging notes. Useful for finding extra context when the current failure seems related to prior work.`
}

export function renderPersonalWikiBlock(personalWikiPath?: string | null): string {
  const body = renderPersonalWikiMap(personalWikiPath)
  return body
    ? `${PERSONAL_WIKI_START}\n${body}\n${PERSONAL_WIKI_END}`
    : `${PERSONAL_WIKI_START}\n${PERSONAL_WIKI_END}`
}

export function applyPersonalWikiBlock(
  content: string,
  personalWikiPath?: string | null,
): string {
  const startIdx = content.indexOf(PERSONAL_WIKI_START)
  const endIdx = content.indexOf(PERSONAL_WIKI_END)
  const block = renderPersonalWikiBlock(personalWikiPath)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content
  return content.slice(0, startIdx) + block + content.slice(endIdx + PERSONAL_WIKI_END.length)
}

export function syncPersonalWikiAgentDocs(
  projectRoot: string,
  personalWikiPath?: string | null,
): void {
  const templateRoot = getTemplateRoot()
  for (const relPath of AGENT_DOCS) {
    const templatePath = path.join(templateRoot, relPath)
    if (!fs.existsSync(templatePath)) continue

    const targetPath = path.join(projectRoot, relPath)
    const templateContent = fs.readFileSync(templatePath, 'utf-8')
    const managedBlock = extractManagedBlock(templateContent)
    if (!managedBlock) continue

    const existing = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, 'utf-8')
      : ''
    const withManaged = existing.includes(PERSONAL_WIKI_START)
      ? existing
      : applyManagedBlock(existing, managedBlock, relPath)
    const next = applyPersonalWikiBlock(withManaged, personalWikiPath)
    if (next !== existing) {
      fs.writeFileSync(targetPath, next)
    }
  }
}

function getTemplateRoot(): string {
  return resolveFirstExisting([
    path.resolve(__dirname, '../templates/project'),
    path.resolve(__dirname, '../../templates/project'),
  ])
}

function resolveFirstExisting(pathsToTry: string[]): string {
  const match = pathsToTry.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error(`Could not resolve any expected path: ${pathsToTry.join(', ')}`)
  }
  return match
}

function extractManagedBlock(content: string): string | null {
  const startIdx = content.indexOf(MANAGED_START)
  const endIdx = content.indexOf(MANAGED_END)
  if (startIdx === -1 || endIdx === -1) return null
  return content.slice(startIdx, endIdx + MANAGED_END.length)
}

function applyManagedBlock(existing: string, block: string, relPath: string): string {
  const startIdx = existing.indexOf(MANAGED_START)
  const endIdx = existing.indexOf(MANAGED_END)

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + MANAGED_END.length)
    return before + block + after
  }

  const signature = LEGACY_SIGNATURES[relPath]
  if (signature && existing.trimStart().startsWith(signature)) {
    return block + '\n'
  }

  const trimmed = existing.trimEnd()
  return trimmed + (trimmed.length > 0 ? '\n\n' : '') + block + '\n'
}
