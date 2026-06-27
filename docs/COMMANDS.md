# Canary Lab Commands

CLI reference for Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

```bash
npx canary-lab init <folder> [--port <port>] [--no-install]
npx canary-lab setup
npx canary-lab ui
npx canary-lab mcp [--profile repair|verify|author|portify|lifecycle|full]
npx canary-lab mcp doctor [--profile repair|verify|author|portify|lifecycle|full]
npx canary-lab new feature <name> --description "..."
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
npx canary-lab upgrade
```

- `init` scaffolds the workspace, then runs `npm install` + the Playwright browser download and registers tools — so `ui` boots immediately. Pass `--no-install` to scaffold only (CI / offline) and install manually afterward.
- `ui` is the primary human workflow.
- `setup` refreshes the agent/tool registration described in [Quick Start](../README.md#quick-start).
- `mcp` bridges local AI clients into the UI server, starting it if needed. It defaults to `lifecycle` — the everyday end-to-end loop (authoring + run/heal + verify + export, no portify). Narrow it with `--profile repair` for run/heal only, `--profile verify` for deployment checks, `--profile author` for authoring; use `--profile portify` for the specialized port-injection workflow, or `--profile full` for the complete surface (lifecycle + portify).
- `new feature` and `env` are deterministic wrappers for scripts and agents.
- `upgrade` syncs scaffolded docs and skills in an existing project (not a dependency upgrade).

## Requirement Coverage (MCP, `author`/`lifecycle`/`full` profiles)

The coverage ledger is reachable over MCP as well as the UI — both call the same computation, so they can't diverge:

- `get_feature_coverage(feature)` — the full ledger: each requirement → its mapped tests → a gap type (`covered` / `path-incomplete` / `variant-incomplete` / `untested`), the coverage %, and the per-test strictness grade with a suggested stronger check.
- `list_feature_docs(feature)` — the docs that feed the PRD (source vs generated), plus the summary status.
- `start_external_summary(feature)` → `submit_external_summary(jobId, requirements)` — YOU read the source docs (returned in the prompt) and propose the requirements; canary reconciles ids (preserving existing ones) and writes the summary. No local agent — over MCP you author it. Add docs first with `write_feature_doc`.
- `start_external_coverage(feature)` → `submit_external_coverage(jobId, mappings)` — YOU read the tests and map them to requirements; canary writes the `@req-*` tags and recomputes. Needs a summary first.

Tests link to requirements via Playwright tags on each `test()` — `{ tag: ['@req-<id>', '@path-happy|sad|edge'] }` (legacy `@requirement`/`@path` comments still parse); see [FEATURES](FEATURES.md#requirement-coverage). Canary computes coverage from your tags; it never writes a requirement's test for you.
