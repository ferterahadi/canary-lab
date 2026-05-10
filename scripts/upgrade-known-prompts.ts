/**
 * Known-prior heal-prompt blocks (verbatim, between but excluding the
 * `<!-- heal-prompt:start -->` / `<!-- heal-prompt:end -->` markers, with
 * surrounding whitespace trimmed). When the user's CLAUDE.md heal-prompt
 * matches one of these byte-for-byte, we know they're carrying a prior
 * canary-lab template and can render a precise upgrade hint.
 *
 * Append-only — never remove entries; older versions still need detection.
 */
export const KNOWN_OLD_HEAL_PROMPTS: { version: string; body: string }[] = [
  {
    version: '0.9.x',
    body: `Playwright failed. Fix service/app code, not tests.

Start here:
- \`logs/heal-index.md\` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact \`logs/failed/...\` slice paths.
- \`logs/e2e-summary.json\` — raw Playwright summary. Use only if \`heal-index.md\` is missing or incomplete.

Useful only when needed:
- \`logs/failed/<slug>/<svc>.log\` — pre-sliced service logs referenced by \`heal-index.md\`.
- \`logs/svc-<name>.log\` — full service log. Use only if a slice is missing or too short.
- \`logs/diagnosis-journal.md\` — prior heal attempts. Use only when the current prompt or index says prior iterations exist.
- \`logs/signal-history.json\` — signal history. Rarely needed.

Rules:
- Do not read the test spec unless the failure cannot be understood from the index and logs.
- Prefer exact slice paths from \`heal-index.md\` before broad repo search.
- After fixing, write \`logs/.restart\` for service/app changes or \`logs/.rerun\` for test/config-only changes.
- Signal body: \`{"hypothesis":"…","filesChanged":["<abs-path>", …]}\`.`,
  },
]
