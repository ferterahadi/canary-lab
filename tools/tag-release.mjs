#!/usr/bin/env node
// Create or move the git tag matching package.json's version, push it, and
// (if the `gh` CLI is available) publish a matching GitHub Release whose
// notes are the tag's section of docs/CHANGELOG.md — this is what makes the
// changelog show up on https://github.com/<owner>/<repo>/tags and /releases
// instead of a bare tag with no notes.
//
// Usage:
//   node tools/tag-release.mjs                 -> create tag v<version>, push, publish release
//   node tools/tag-release.mjs --force          -> move tag if it already exists (retag)
//   node tools/tag-release.mjs --no-push        -> tag locally only, skip push + release
//   node tools/tag-release.mjs --no-release     -> tag + push, skip the GitHub Release

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const force = process.argv.includes("--force");
const skipPush = process.argv.includes("--no-push");
const skipRelease = process.argv.includes("--no-release");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${pkg.version}`;

function git(args, opts = {}) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts }).trim();
}

// Pull the changelog section covering `version` — either its own `## X.Y.Z`
// heading, or (if patch releases were folded into one entry, e.g. `## 1.4.x —
// ...`) the `## X.Y.x` range heading — up to (not including) the next `---`
// divider or `## ` heading. Falls back to a generic note if neither exists
// (e.g. the changelog step was skipped for this release).
function changelogNotesFor(version) {
  const changelog = readFileSync(new URL("../docs/CHANGELOG.md", import.meta.url), "utf8");
  const [major, minor] = version.split(".");
  const escaped = version.replace(/\./g, "\\.");
  const rangeEscaped = `${major}\\.${minor}\\.x`;
  const heading = new RegExp(`^## (${escaped}|${rangeEscaped})(\\s|—).*$`, "m");
  const start = changelog.search(heading);
  if (start === -1) return `Release ${tag}.`;
  const afterHeading = changelog.slice(start);
  const endMatch = afterHeading.slice(1).search(/^(---|## )/m);
  const section = endMatch === -1 ? afterHeading : afterHeading.slice(0, endMatch + 1);
  return section.trim();
}

let existing = "";
try { existing = git(["tag", "-l", tag]); } catch { /* none */ }

if (existing && !force) {
  console.error(`Tag ${tag} already exists. Re-run with --force to move it to the current commit.`);
  process.exit(1);
}

if (existing && force) {
  console.log(`Moving existing tag ${tag} to HEAD...`);
  git(["tag", "-d", tag]);
  try { execFileSync("git", ["push", "origin", `:refs/tags/${tag}`], { stdio: "inherit" }); } catch { /* not on remote yet */ }
}

git(["tag", "-a", tag, "-m", `Release ${tag}`]);
console.log(`Created tag ${tag} at HEAD.`);

if (skipPush) {
  console.log(`Push it with:  git push origin ${tag}`);
  process.exit(0);
}

execFileSync("git", ["push", "origin", tag], { stdio: "inherit" });

if (skipRelease) process.exit(0);

let hasGh = true;
try { execFileSync("gh", ["--version"], { stdio: "ignore" }); } catch { hasGh = false; }

if (!hasGh) {
  console.log("`gh` CLI not found — skipping GitHub Release. Install it (https://cli.github.com) to publish one automatically next time,");
  console.log(`or run manually:  gh release create ${tag} --title ${tag} --notes-file docs/CHANGELOG.md`);
  process.exit(0);
}

// Idempotent: if a release already exists for this tag (retag/force, or a
// re-run after a partial failure), replace it rather than erroring out.
try { execFileSync("gh", ["release", "delete", tag, "--yes", "--cleanup-tag=false"], { stdio: "ignore" }); } catch { /* none yet */ }

const notes = changelogNotesFor(pkg.version);
execFileSync("gh", ["release", "create", tag, "--title", tag, "--notes", notes, "--latest"], {
  stdio: "inherit",
});
console.log(`Published GitHub Release ${tag}.`);
