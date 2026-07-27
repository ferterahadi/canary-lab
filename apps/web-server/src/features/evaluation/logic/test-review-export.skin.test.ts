import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createEvaluationHtml } from './test-review-export'
import { detail } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// The skin's whole reason for existing is that the previous one measured badly:
// the smallest text sat at 3.34:1 and card hairlines at 1.28:1, so the page read
// as mush. These floors are the fix — pinned here because a palette tweak is
// exactly the kind of edit that regresses them without anyone noticing.
describe('report skin contrast', () => {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const luminance = (hex: string): number => {
    const n = parseInt(hex.replace('#', ''), 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const tokensIn = (css: string, selector: string): Record<string, string> => {
    const start = css.indexOf(selector + ' {')
    expect(start, `${selector} block missing from the report stylesheet`).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf('\n}', start))
    const out: Record<string, string> = {}
    for (const [, name, hex] of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[name] = hex
    return out
  }

  const MODES: Array<[string, string]> = [['light', ':root'], ['dark', ':root[data-theme="dark"]']]

  it.each(MODES)('keeps %s text, hairlines and status pills above their floors', async (_mode, selector) => {
    const tokens = tokensIn(await createEvaluationHtml(detail({ featureDir: tmpDir })), selector)
    const surface = tokens['--surface']

    // Body copy AND the smallest labels — sublines, field labels, nav numbers.
    expect(contrast(tokens['--ink'], surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens['--ink-2'], surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens['--ink-3'], surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens['--accent'], surface)).toBeGreaterThanOrEqual(4.5)

    // The hairline is what draws every boundary once the cards are dissolved,
    // so it is load-bearing structure rather than decoration.
    expect(contrast(tokens['--rule'], surface)).toBeGreaterThanOrEqual(1.8)
    expect(contrast(tokens['--rule-2'], surface)).toBeGreaterThanOrEqual(2.5)

    // Status pills set their own text on their own tint, so each pair has to
    // clear the floor independently of the page surface.
    for (const status of ['ok', 'bad', 'warn', 'skip', 'none']) {
      expect(
        contrast(tokens[`--${status}`], tokens[`--${status}-soft`]),
        `--${status} on --${status}-soft`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('sets prose in the serif at reading size and keeps field labels sentence-case', async () => {
    const html = await createEvaluationHtml(detail({ featureDir: tmpDir }))

    expect(html).toContain('--size-prose: 16.5px')
    expect(html).toContain('--leading-prose: 1.72')
    expect(html).toMatch(/\.lede,[^{]*\.case-explainer[^{]*\{\s*font-family: var\(--font-serif\)/)
    // 9.5px uppercase mono at 0.1em tracking was the least legible text in the
    // old skin; field labels are now read, not decoded.
    expect(html).not.toContain('font-size: 9.5px')
    expect(html).toMatch(/dt \{[^}]*font-size: var\(--size-label\)[^}]*\}/)
    expect(html).not.toMatch(/dt \{[^}]*text-transform: uppercase/)
  })
})
