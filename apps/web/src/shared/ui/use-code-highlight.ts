import { useEffect, useState } from 'react'
import { useTheme } from '../lib/theme'
import { codeThemeFor, getCodeHighlighter } from './code-highlighter'

interface HighlightedCode {
  source: string
  theme: string
  html: string
  lines: string[]
  canvas: { bg?: string; fg?: string }
}

/** Highlight complete source once, so diff rows retain multiline token context.
 * Both ordinary Shiki blocks and aligned comparisons consume this result. */
export function useCodeHighlight(source: string): HighlightedCode | null {
  const { resolved } = useTheme()
  const theme = codeThemeFor(resolved)
  const [result, setResult] = useState<HighlightedCode | null>(null)
  useEffect(() => {
    let cancelled = false
    getCodeHighlighter().then((highlighter) => {
      const html = highlighter.codeToHtml(source, { lang: 'typescript', theme })
      const template = document.createElement('template')
      template.innerHTML = html
      const lines = [...template.content.querySelectorAll('code > .line')].map((line) => line.innerHTML)
      if (!cancelled) setResult({ source, theme, html, lines, canvas: highlighter.themeColors(theme) })
    }).catch(() => { if (!cancelled) setResult(null) })
    return () => { cancelled = true }
  }, [source, theme])
  return result?.source === source && result.theme === theme ? result : null
}
