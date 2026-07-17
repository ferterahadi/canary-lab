---
name: cl_apply-local
description: Use on THIS machine when a canary-lab apps/web-server/** or apps/web/** change needs live proof and you want to rebuild + reinstall + restart the workspace UI yourself, instead of handing the canary-apply cycle off to the user. Local-only override of the cl_verify-changes Tier-3 hand-off rule; gitignored, never shipped.
---

# Apply Canary Lab changes locally (rebuild + restart)

Local-only. This machine relaxes the "user runs canary-apply themselves" hand-off
(cl_verify-changes Tier 3, AGENTS.md hard rule, memory `feedback_canary_apply_self`)
so verification can go end-to-end without waiting on the user. Only valid here — the
skill dir is gitignored and must never ship.

**When to use:** a `apps/web-server/**` or `apps/web/**` edit needs Tier-3 live proof
and the user hasn't said they'll run the cycle. For an `apps/web`-only visual check you
can skip this and run the Vite dev server (`canary-web-dev` launch config) — faster, HMR,
no rebuild. Use this skill when the change touches the server, or you need the real
built bundle the production server serves.

## The cycle

Run the three steps in order. Never hardcode the port — derive it every time
(this workspace has flipped 7420↔7421; `active-servers.json` reflects the *actual*
bound port even after a switch).

### 1. Rebuild + reinstall the tarball into the workspace

```bash
zsh -ic 'canary-apply'
```

`canary-apply` (defined in `~/.zshrc`) does `npm run build` → `npm pack` →
`npm install <tarball>` against `~/Documents/canary-lab-workspace`. It uses absolute
paths, so cwd doesn't matter. Foreground; wait for `✔ applied …`. The running server
is still on the *old* tarball until you restart it (step 3).

### 2. Kill the running server (derive the port)

```bash
PORT=$(jq -r '.servers[0].port // empty' ~/.canary-lab/active-servers.json 2>/dev/null)
PORT=${PORT:-$(jq -r '.port // 7421' ~/Documents/canary-lab-workspace/canary-lab.config.json)}
lsof -ti:"$PORT" | xargs kill 2>/dev/null || true
echo "killed port $PORT"
```

`active-servers.json` is the most authoritative source; fall back to the config
(`7421` when `.port` is unset).

### 3. Re-run the UI (long-running — background it)

```bash
cd ~/Documents/canary-lab-workspace && npx canary-lab ui
```

This blocks (it's the server). Run it in the **background** (`run_in_background: true`)
so the turn continues. It re-reads the config, so the port may change on boot.

### 4. Health-check, then exercise the change

Re-derive the port (it may have switched on restart) and poll:

```bash
PORT=$(jq -r '.servers[0].port // 7421' ~/.canary-lab/active-servers.json 2>/dev/null)
for i in $(seq 1 20); do curl -s -m 2 "http://127.0.0.1:$PORT/mcp/health" && break; sleep 2; done
```

Then drive the changed surface — MCP tools for run-loop work, or the browser preview
(`preview_start {url: "http://127.0.0.1:$PORT"}`) for UI. Only claim it works after
you've observed the new behavior on the restarted server.

## Common mistakes

| Mistake | Reality |
| --- | --- |
| Hardcoding 7421 | Workspace port has flipped; derive from `active-servers.json` each time |
| Running `npx canary-lab ui` in the foreground | It never returns — background it or the turn hangs |
| Skipping step 2 | Old process keeps the port; new UI can't bind / you test stale code |
| Duplicating the build steps inline | Call `canary-apply` so the `~/.zshrc` function stays the single source of truth |
| Using this in a shipped/cloned checkout | Local-only; the skill dir is gitignored and this override doesn't apply elsewhere |
