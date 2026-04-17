#!/usr/bin/env node
// Generate a new CHANGELOG.md entry using the Claude CLI.
//
// How it works:
//   1. Reads the version from package.json.
//   2. Finds the previous version tag (the most recent v* tag that isn't
//      the current one).
//   3. Collects commit messages + a diff summary since that tag.
//   4. Pipes it all to `claude -p` and asks for a plain-English summary.
//   5. Prepends the new section to CHANGELOG.md.
//
// Usage:
//   node tools/generate-changelog.mjs           -> write to CHANGELOG.md
//   node tools/generate-changelog.mjs --dry-run -> print to stdout only

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;
const newTag = `v${version}`;

function git(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// Find the most recent version tag that isn't the current one.
let prevTag = "";
try {
  const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t !== newTag);
  prevTag = tags[0] || "";
} catch { /* no tags yet */ }

const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
console.error(`Generating changelog for ${newTag} (range: ${range})`);

const commits = (() => {
  try { return git(["log", "--pretty=format:- %s", range]); } catch { return ""; }
})();

const diffstat = (() => {
  try { return git(["diff", "--stat", range]); } catch { return ""; }
})();

if (!commits && !diffstat) {
  console.error("No commits or changes found. Did you forget to commit, or is the previous tag wrong?");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const prompt = `You are writing a changelog entry for a tool called Canary Lab.

Write a new section for version ${version} (dated ${today}) based on the commits and file changes below.

RULES — very important:
- Use plain English. Write like you're explaining to a friend who doesn't code.
- No jargon, no acronyms unless they're household words.
- Don't mention file names, function names, or internal code paths.
- Don't say things like "refactored", "implemented", "utility", "abstraction", "API surface".
- Focus on what the user will notice or benefit from.
- Group items under these headings if they apply: "What's new", "Improvements", "Housekeeping".
- If a commit is just a version bump or purely internal, skip it or mention it briefly under Housekeeping.
- Each bullet: one short sentence. Start with a bold phrase, then a plain explanation.
- Output ONLY the markdown section starting with "## ${version} — ${today}". No preamble, no code fences, no closing remarks.

Commits since ${prevTag || "the beginning"}:
${commits || "(none)"}

Changed files:
${diffstat || "(none)"}
`;

console.error("Calling claude CLI...");
const result = spawnSync("claude", ["-p", prompt], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
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
const header = `# Changelog\n\nAll notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.\n\n`;

let existing = "";
if (existsSync(changelogPath)) {
  existing = readFileSync(changelogPath, "utf8");
}

let body = existing.startsWith("# Changelog") ? existing.slice(existing.indexOf("\n\n") + 2) : existing;
body = body.replace(/^All notable changes.*?\n\n/s, "");

const updated = `${header}${generated}\n\n---\n\n${body.trim()}\n`;
writeFileSync(changelogPath, updated);

console.log(`CHANGELOG.md updated with section for ${version}.`);
console.log(`Review it, commit, then tag:  npm run tag`);
