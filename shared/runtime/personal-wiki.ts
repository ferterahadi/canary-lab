export const PERSONAL_WIKI_START = '<!-- personal-wiki:start -->'
export const PERSONAL_WIKI_END = '<!-- personal-wiki:end -->'

export function renderPersonalWikiMap(personalWikiPath?: string | null): string {
  const wikiPath = personalWikiPath?.trim()
  if (!wikiPath) return ''
  return `- \`${wikiPath}\` — Karpathy-style personal wiki: distilled prior agent sessions as cross-linked markdown, LLM-curated and append-only. Look for an index/home/readme file at the root as a TOC; notes use \`[[wikilinks]]\` — follow links rather than re-grepping. Consult when the current failure seems related to prior work.`
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
