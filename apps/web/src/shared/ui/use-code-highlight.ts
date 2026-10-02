import { useEffect, useState } from 'react'
import { useTheme } from '../lib/theme'
import { codeThemeFor, getCodeHighlighter, type CodeLanguage } from './code-highlighter'

interface HighlightedCode {
  source: string
  lang: CodeLanguage
  theme: string
  html: string
  lines: string[]
  canvas: { bg?: string; fg?: string; comment?: string }
}

/** Highlight complete source once, so diff rows retain multiline token context.
 * Both ordinary Shiki blocks and aligned comparisons consume this result. */
export function useCodeHighlight(source: string, lang: CodeLanguage = 'typescript'): HighlightedCode | null {
  const { resolved } = useTheme()
  const theme = codeThemeFor(resolved)
  const [result, setResult] = useState<HighlightedCode | null>(null)
  useEffect(() => {
    let cancelled = false
    getCodeHighlighter().then(async (highlighter) => {
      if (lang !== 'typescript') await highlighter.loadLanguage(lang)
      const html = highlighter.codeToHtml(source, { lang, theme })
      const template = document.createElement('template')
      template.innerHTML = html
      const lines = [...template.content.querySelectorAll('code > .line')].map((line) => line.innerHTML)
      if (!cancelled) setResult({ source, lang, theme, html, lines, canvas: highlighter.themeColors(theme) })
    }).catch(() => { if (!cancelled) setResult(null) })
    return () => { cancelled = true }
  }, [source, lang, theme])
  return result?.source === source && result.lang === lang && result.theme === theme ? result : null
}
