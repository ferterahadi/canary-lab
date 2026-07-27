import path from 'path'

/** Runs before first paint so a dark-mode reader never sees a white flash, and so
 *  a stored preference wins over the OS setting. Kept tiny and dependency-free —
 *  the report is a single file that has to work from a zip, offline. */
export const THEME_BOOT_SCRIPT = `
(() => {
  try {
    const stored = localStorage.getItem('canary-evaluation-theme')
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored)
  } catch (err) { /* private mode / file:// with storage blocked — fall back to the OS setting */ }
})()
`

export const THEME_SWITCH_HTML = `<div class="theme-switch" role="radiogroup" aria-label="Colour theme">
  <button type="button" data-theme-set="light" role="radio" aria-checked="false" title="Light"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><g stroke-linecap="round"><path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"/></g><span></span></svg><span class="sr-only">Light</span></button>
  <button type="button" data-theme-set="auto" role="radio" aria-checked="true" title="Match system"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.4" y="3.6" width="15.2" height="10.4" rx="1.6"/><path d="M6.5 16.8h7" stroke-linecap="round"/></svg><span class="sr-only">System</span></button>
  <button type="button" data-theme-set="dark" role="radio" aria-checked="false" title="Dark"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.2 12.3A6.8 6.8 0 0 1 7.7 3.8a6.9 6.9 0 1 0 8.5 8.5Z"/></svg><span class="sr-only">Dark</span></button>
</div>`
