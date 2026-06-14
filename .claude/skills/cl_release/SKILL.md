---
name: cl_release
description: Use when publishing a new canary-lab version to npm — changelog, version bump, smoke test, publish, tag.
disable-model-invocation: true
---

# Releasing canary-lab

User-invoked only (`/cl_release`). Publishing is outward-facing — confirm the version
and changelog with the user before `publish:package`.

## Checklist

1. **Changelog**: `npm run changelog:preview` (dry run), then `npm run changelog`.
   Entries are plain-language and area-tagged per the `docs/CHANGELOG.md` header:
   `[Test Runner]`, `[Test Generation]`, `[Export evaluation]`, `[General]`.
   If consumers should refresh their workspace (template/sample changes, MCP
   re-registration), say so in the release's header line
   (e.g. "Run `npx canary-lab upgrade` …" / "run `npx canary-lab setup`").
2. **Version**: bump `version` in `package.json` (the changelog and tag tools read
   it).
3. **Gates**: `npx vitest run`, `npx tsc -p tsconfig.build.json --noEmit`, then
   `npm run smoke:pack` (builds, packs, scaffolds a temp project, verifies the
   scaffold flow).
4. **Publish**: `npm run publish:package` — refuses a dirty worktree
   (`--allow-dirty` is the escape hatch; prefer committing instead).
5. **Tag**: `npm run tag` (`tag:force` only to move a botched tag).

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Publishing without `smoke:pack` | A broken scaffold/tarball ships; `prepack` builds but doesn't verify the scaffold flow |
| Changelog entries in engineer-speak | The changelog promises plain language anyone can follow |
| Forgetting the upgrade/setup note | Consumers keep stale samples or unregistered MCP tools and report "bugs" |
