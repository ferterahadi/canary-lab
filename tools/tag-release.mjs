#!/usr/bin/env node
// Create or move the git tag matching package.json's version.
// Usage:
//   node tools/tag-release.mjs          -> create tag v<version>
//   node tools/tag-release.mjs --force  -> move tag if it already exists (retag)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const force = process.argv.includes("--force");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${pkg.version}`;

function git(args, opts = {}) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts }).trim();
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
}

git(["tag", "-a", tag, "-m", `Release ${tag}`]);
console.log(`Created tag ${tag} at HEAD.`);
console.log(`Push it with:  git push origin ${tag}`);
