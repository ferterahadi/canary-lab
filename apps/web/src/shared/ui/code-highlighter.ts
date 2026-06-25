// One Shiki highlighter for the whole web app. The core + Oniguruma wasm + the
// TypeScript grammar + both themes are ~600kB; loading them ONCE behind a module
// singleton means every code view (test playback, coverage source, spec preview)
// shares the same payload instead of each component initialising its own copy.
// The TypeScript grammar also covers JavaScript for our purposes, so callers pass
// `lang: 'typescript'` for both .ts and .js.

type Highlighter = { codeToHtml: (code: string, opts: { lang: string; theme: string }) => string }

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
      return { codeToHtml: (code, opts) => hl.codeToHtml(code, opts) }
    })()
  }
  return highlighterPromise
}

/** The Shiki theme name for the resolved app theme. */
export function codeThemeFor(resolved: 'dark' | 'light'): string {
  return resolved === 'dark' ? 'one-dark-pro' : 'one-light'
}
