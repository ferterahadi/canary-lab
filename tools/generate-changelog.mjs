#!/usr/bin/env node
// Generate a new CHANGELOG.md entry using the Claude CLI.
//
// How it works:
//   1. Reads the version from package.json.
//   2. Finds the previous `release/*` branch (semver-sorted) and diffs against
//      it. If `release/1.0.6` doesn't exist, falls back to the next-older
//      branch that does (e.g. `release/0.9.3`).
//   3. Collects commit messages + a diff summary across that range.
//   4. Pipes it all to `claude -p` and asks for a plain-English summary
//      shaped like the existing CHANGELOG entries (category-tagged bullets).
//   5. Splices the new section into CHANGELOG.md above the most recent entry,
//      leaving the title / description / category legend untouched.
//
// Usage:
//   node tools/generate-changelog.mjs           -> write to CHANGELOG.md
//   node tools/generate-changelog.mjs --dry-run -> print the generated section to stdout

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;
const currentBranch = `release/${version}`;

function git(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// Find the previous release branch: the latest `release/<semver>` (local or
// remote-tracking) that isn't the current one. Semver-desc sort means a
// missing intermediate version (e.g. 1.0.5) naturally falls through to the
// next-older one that exists.
let prevBranch = "";
try {
  const refs = git([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/release/*",
    "refs/remotes/origin/release/*",
  ])
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);

  const currentParts = version.split(".").map(Number);
  const cmp = (a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
  };

  const versions = new Map();
  for (const ref of refs) {
    const name = ref.replace(/^origin\//, "");
    const match = /^release\/(\d+)\.(\d+)\.(\d+)$/.exec(name);
    if (!match) continue;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (cmp(parts, currentParts) >= 0) continue; // only strictly lower versions
    versions.set(name, parts);
  }

  const sorted = [...versions.entries()].sort(([, a], [, b]) => cmp(b, a));
  prevBranch = sorted[0]?.[0] || "";
} catch { /* no release branches yet */ }

const range = prevBranch ? `${prevBranch}..HEAD` : "HEAD";
console.error(`Generating changelog for v${version} (range: ${range})`);

const commits = (() => {
  try { return git(["log", "--pretty=format:- %s", range]); } catch { return ""; }
})();

const diffstat = (() => {
  try { return git(["diff", "--stat", range]); } catch { return ""; }
})();

if (!commits && !diffstat) {
  console.error("No commits or changes found. Did you forget to commit, or is the previous release branch wrong?");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const prompt = `You are writing a changelog entry for a tool called Canary Lab.

Write a new section for version ${version} (dated ${today}) based on the commits and file changes below.

FORMAT — match the existing CHANGELOG.md style exactly:
- Start the section with: ## ${version} — ${today}
- Optional one-line blockquote (\`> ...\`) directly under the heading ONLY if there's a real upgrade note the user must act on (e.g. re-run \`npx canary-lab upgrade\`). Otherwise omit.
- Then a flat list of bullets. NO sub-headings like "What's new", "Improvements", or "Housekeeping".
- Each bullet uses this exact shape, including the bold tag and bold title:
  - **[Category]** **Short bold title.** Plain-English explanation.
- If — and only if — the release has breaking changes, append a \`### Breaking changes\` subsection at the end with bullets in the same shape.

CATEGORIES — pick exactly one per bullet, written inside square brackets, exactly as spelled here:
- [Test Runner] — running tests, run history, auto-heal, services, logs
- [Test Generation] — Add Test wizard, PRD/plan/spec drafting
- [Export evaluation] — exported evaluation reports
- [Benchmark] — self-heal benchmarking
- [General] — UI shell, CLI, scaffolding, packaging

WRITING RULES — very important:
- Use plain English. Write like you're explaining to a friend who doesn't code.
- No jargon, no acronyms unless they're household words.
- Don't mention file names, function names, or internal code paths.
- Don't say "refactored", "implemented", "utility", "abstraction", "API surface".
- Focus on what the user will notice or benefit from.
- One short sentence per bullet.
- If a commit is purely a version bump or trivially internal, skip it.
- Output ONLY the markdown section starting with "## ${version} — ${today}". No preamble, no code fences, no closing remarks.

Commits since ${prevBranch || "the beginning"}:
${commits || "(none)"}

Changed files:
${diffstat || "(none)"}
`;

console.error("Calling claude CLI...");
const result = spawnSync("claude", ["-p", "--tools="], {
  encoding: "utf8",
  input: prompt,
  stdio: ["pipe", "pipe", "inherit"],
});

if (result.status !== 0) {
  console.error(`claude CLI exited with code ${result.status}.`);
  process.exit(result.status || 1);
}

const generated = (result.stdout || "").trim();
if (!generated) {
  console.error("Claude returned empty output.");
  process.exit(1);
}

if (dryRun) {
  console.log(generated);
  process.exit(0);
}

const changelogPath = new URL("../CHANGELOG.md", import.meta.url);

const defaultPreamble = `# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.
---
Each entry is tagged with the area it touches:

- **[Test Runner]** — running tests, run history, auto-heal, services, logs
- **[Test Generation]** — Add Test wizard, PRD/plan/spec drafting
- **[Export evaluation]** — exported evaluation reports
- **[Benchmark]** — self-heal benchmarking (retired in 1.0.0)
- **[General]** — UI shell, CLI, scaffolding, packaging

---
`;

if (!existsSync(changelogPath)) {
  const fresh = `${defaultPreamble}${generated}\n`;
  writeFileSync(changelogPath, fresh);
} else {
  const existing = readFileSync(changelogPath, "utf8");
  const firstEntryIdx = existing.search(/^## /m);

  let preamble;
  let rest;
  if (firstEntryIdx === -1) {
    preamble = existing.endsWith("\n") ? existing : `${existing}\n`;
    rest = "";
  } else {
    preamble = existing.slice(0, firstEntryIdx);
    rest = existing.slice(firstEntryIdx);
  }

  const trailingRest = rest.trim();
  const updated = trailingRest
    ? `${preamble}${generated}\n\n---\n\n${trailingRest}\n`
    : `${preamble}${generated}\n`;

  writeFileSync(changelogPath, updated);
}

console.log(`CHANGELOG.md updated with section for ${version}.`);
console.log(`Review it, commit, then tag:  npm run tag`);
