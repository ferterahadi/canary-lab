# Canary Lab Commands

CLI reference for Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

```bash
npx canary-lab init <folder> [--port <port>]
npx canary-lab setup
npx canary-lab ui
npx canary-lab mcp [--profile repair|verify|author|full]
npx canary-lab mcp doctor [--profile repair|verify|author|full]
npx canary-lab new feature <name> --description "..."
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
npx canary-lab upgrade
```

- `ui` is the primary human workflow.
- `setup` refreshes the agent/tool registration described in [Quick Start](../README.md#quick-start).
- `mcp` bridges local AI clients into the UI server, starting it if needed. It defaults to `repair`; use `--profile verify` for deployment checks, `--profile author` for authoring, or `--profile full` for the complete surface.
- `new feature` and `env` are deterministic wrappers for scripts and agents.
- `upgrade` syncs scaffolded docs and skills in an existing project (not a dependency upgrade).
