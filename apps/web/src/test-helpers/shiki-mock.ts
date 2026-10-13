/** Module factory for `vi.mock('shiki/core', …)`: the shared ShikiCode block
 *  lazily imports Shiki, and this stands in for the real wasm highlighter so it
 *  resolves deterministically with one `<span class="line">` per source line. */
export function shikiCoreMock() {
  return {
    createHighlighterCore: async () => ({
      codeToHtml: (code: string) => (
        `<pre class="shiki one-dark-pro"><code>${
          code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')
        }</code></pre>`
      ),
    }),
  }
}
