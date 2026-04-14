---
name: Self-Healing E2E Loop
description: Run E2E tests via `yarn e2e`, then autonomously diagnose and fix failures by analyzing cross-service logs with XML markers. Max 3 retries per failing test case.
type: skill
---

# Self-Healing E2E Loop

## Overview

This skill runs E2E tests and automatically fixes failures by correlating
per-service logs. Each service's stdout is captured to `logs/svc-{name}.log`
with XML markers (`<test-case-X>` / `</test-case-X>`) injected at test
boundaries. A summary file (`logs/e2e-summary.json`) reports pass/fail.

## Procedure

### 1. Start or reuse the E2E suite

Before launching, check whether services are already running and the runner
is in watch mode. This avoids re-running the full interactive flow.

#### Decision tree

1. **Runner is in watch mode** (a terminal is sitting at "Waiting for signal..."):
   - To re-run tests only: `touch logs/.rerun`
   - To restart services + re-run: `touch logs/.restart`
   - Skip to step 2.

2. **Runner exited but services may still be up** — check health endpoints
   from the feature's `feature.config.ts`. If healthy, run Playwright directly:
   ```bash
   cd features/<name> && npx playwright test --reporter=../../shared/e2e-runner/summary-reporter.ts,list
   ```

3. **Services are not running** — start fresh:
   ```bash
   yarn e2e
   ```

> **Note:** `yarn e2e` kills all service processes on exit (Ctrl+C).

### 2. Check results

Read `logs/e2e-summary.json`:
```json
{
  "total": 20,
  "passed": 18,
  "failed": [
    {
      "name": "test-case-send-message",
      "logs": {
        "svc-api-server": "... relevant log lines during this test ...",
        "svc-worker": "... relevant log lines during this test ..."
      }
    }
  ]
}
```

If `failed` is empty, all tests pass.

Each failed entry includes `logs` — per-service log snippets extracted from
XML markers, giving you the cross-service view without running `sed` manually.

### 3. For each failing test case (max 3 retries each)

#### a. Read the log snippets from the summary

The `logs` field in each failed entry contains the relevant service output
during that test case. If you need raw logs, you can still use:
```bash
sed -n '/<test-case-slug>/,/<\/test-case-slug>/p' logs/svc-*.log
```

#### b. Diagnose the failure

Correlate output across services. Look for:
- HTTP error codes (4xx, 5xx)
- Stack traces or exception messages
- Connection failures / timeouts
- Missing data or unexpected null values

#### c. Apply a fix

- **NEVER modify test files.** Fix the implementation in the external repo.
- Verify the fix compiles before proceeding.

#### d. Restart services if needed

```bash
touch logs/.restart
```

#### e. Re-run the tests

```bash
touch logs/.rerun
```

### 4. After 3 retries exhausted

Produce a diagnosis report:
- What was tried
- What the logs showed each time
- Best guess at root cause
- Suggested next steps for manual investigation

### 5. Final confirmation run

After all fixes are applied, trigger one more rerun to confirm no regressions.

## Rules

1. **NEVER modify test files.** Always fix the implementation.
2. **Max 3 auto-fix iterations** per test case before escalating.
3. **Always read service logs** alongside test output.
4. **Verify fixes compile** before restarting services.
5. **If a fix requires a service restart**, use `touch logs/.restart`; otherwise use `touch logs/.rerun`.

## File Layout

```
logs/
├── manifest.json          # paths to all service log files
├── pids/{name}.pid        # PID files for spawned services
├── svc-{name}.log         # per-service stdout with XML markers
├── e2e-summary.json       # {"total", "passed", "failed": [{name, logs}]}
├── .rerun                 # signal: rerun Playwright only
└── .restart               # signal: restart services, then rerun
```
