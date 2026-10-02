// One Shiki highlighter for the whole web app. The core + Oniguruma wasm + the
// TypeScript grammar + both themes are ~600kB; loading them ONCE behind a module
// singleton means every code view (test playback, coverage source, spec preview)
// shares the same payload instead of each component initialising its own copy.
// The TypeScript grammar also covers JavaScript for our purposes, so callers pass
// `lang: 'typescript'` for both .ts and .js. The agent log viewer also shows
// Markdown, JSON, TSX and YAML payloads; those grammars load on first use so a
// test-playback screen never pays for them.

type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string
  /** The theme's own canvas colours — what Shiki paints as the <pre> background
   *  and default/comment token colours — so non-code surfaces can share the
   *  exact Code mode palette. */
  themeColors: (theme: string) => { bg?: string; fg?: string; comment?: string }
  /** Load an on-demand grammar before the first `codeToHtml` that names it. */
  loadLanguage: (lang: ExtraCodeLanguage) => Promise<void>
}

/** Grammars beyond the always-loaded TypeScript one, each its own lazy chunk. */
export type ExtraCodeLanguage = 'markdown' | 'json' | 'tsx' | 'yaml'
export type CodeLanguage = 'typescript' | ExtraCodeLanguage

const EXTRA_GRAMMARS: Record<ExtraCodeLanguage, () => Promise<{ default: unknown }>> = {
  markdown: () => import('shiki/langs/markdown.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

let highlighterPromise: Promise<Highlighter> | null = null

export function getCodeHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, ts, dark, light, wasm] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/themes/one-dark-pro.mjs'),
        import('shiki/themes/one-light.mjs'),
        import('shiki/wasm'),
      ])
      const hl = await createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [ts.default],
        engine: createOnigurumaEngine(wasm.default),
      })
      return {
        codeToHtml: (code, opts) => hl.codeToHtml(code, opts),
        themeColors: (theme) => {
          const registration = hl.getTheme(theme)
          const comment = hl.codeToTokens('// comment', { lang: 'typescript', theme }).tokens[0]?.[0]?.color
          return { bg: registration.bg, fg: registration.fg, comment }
        },
        loadLanguage: async (lang) => {
          if (hl.getLoadedLanguages().includes(lang)) return
          const grammar = await EXTRA_GRAMMARS[lang]()
          await hl.loadLanguage(grammar.default as Parameters<typeof hl.loadLanguage>[0])
        },
      }
    })()
  }
  return highlighterPromise
}

/** The Shiki theme name for the resolved app theme. */
export function codeThemeFor(resolved: 'dark' | 'light'): string {
  return resolved === 'dark' ? 'one-dark-pro' : 'one-light'
}
