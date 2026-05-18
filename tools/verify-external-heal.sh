#!/usr/bin/env bash
# One-shot verification of the Canary Lab × External AI Clients v1 backbone.
#
# Exercises the seven steps from the design plan:
#   1. Start a run with `healAgent: { kind: 'external', ... }` in the body
#   2. Wait for tests to fail and the run to enter 'healing'
#   3. Fetch the heal-context bundle
#   4. Send an explicit heartbeat
#   5. Write a rerun signal
#   6. Stale-disconnect: stop heartbeating, watch the status flip, reconnect
#   7. Single-claim guarantee: a second sessionId is rejected with 409
#
# Pre-reqs (in another terminal):
#   $ canary-apply                                # rebuild + reinstall
#   $ lsof -ti:7421 | xargs kill                  # stop the old UI
#   $ cd ~/Documents/canary-lab-workspace && npx canary-lab ui
#
# Run this script from anywhere:
#   $ ./tools/verify-external-heal.sh
#
# Overrides (all optional — sensible auto-detection if unset):
#   BASE=http://localhost:7421
#   FEATURE=broken_todo_api        # auto-picks any feature whose name contains "broken"
#   SESSION_ID=<uuid>              # auto-generated if not set
#   CLIENT_KIND=claude-desktop     # claude-cli | claude-desktop | codex-cli | codex-desktop | other
#   CONVERSATION_NAME="verify backbone"
#   KEEP_RUN=1                     # skip the auto-abort at the end so you can keep inspecting the UI

set -euo pipefail

BASE="${BASE:-http://localhost:7421}"
FEATURE="${FEATURE:-}"
SESSION_ID="${SESSION_ID:-}"
CLIENT_KIND="${CLIENT_KIND:-claude-desktop}"
CONVERSATION_NAME="${CONVERSATION_NAME:-verify backbone}"
KEEP_RUN="${KEEP_RUN:-}"
# Max seconds to wait for the run to enter 'healing'. Bump for slow suites.
WAIT_FOR_HEALING_SECONDS="${WAIT_FOR_HEALING_SECONDS:-300}"

# ─── colors / logging ───────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_GREY=$'\033[90m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""; C_GREY=""
fi

PASS=0
FAIL=0
banner() { printf '\n%s━━━ %s ━━━%s\n' "$C_BOLD" "$1" "$C_RESET"; }
info()   { printf '  %s%s%s\n' "$C_GREY" "$1" "$C_RESET"; }
pass()   { printf '  %s✓ %s%s\n' "$C_GREEN" "$1" "$C_RESET"; PASS=$((PASS+1)); }
fail()   { printf '  %s✗ %s%s\n' "$C_RED" "$1" "$C_RESET"; FAIL=$((FAIL+1)); }
warn()   { printf '  %s⚠ %s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
visual() { printf '  %s▸ VISUAL: %s%s\n' "$C_BLUE" "$1" "$C_RESET"; }
die()    { fail "$1"; exit 1; }

# ─── JSON helpers (python3 ships with macOS) ────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (used for JSON parsing). Install it and retry." >&2
  exit 2
fi

json_get() {
  # json_get <dotted.key.path> <json-string>
  python3 -c '
import json, sys
try:
  data = json.loads(sys.stdin.read())
except Exception:
  print("")
  sys.exit(0)
for k in sys.argv[1].split("."):
  if data is None: break
  if isinstance(data, list):
    try: data = data[int(k)]
    except Exception: data = None
  elif isinstance(data, dict):
    data = data.get(k)
  else:
    data = None
if data is None: print("")
elif isinstance(data, (dict, list)): print(json.dumps(data))
else: print(data)
' "$1" <<< "$2"
}

# ─── pre-flight ─────────────────────────────────────────────────────────────
banner "Pre-flight"

if ! curl -fsS "$BASE/api/features" >/dev/null 2>&1; then
  die "Canary Lab UI not reachable at $BASE. Is 'canary-lab ui' running on port 7421?"
fi
pass "Canary Lab UI reachable at $BASE"

# Health-probe the MCP route. Not fatal if missing — older builds won't have
# it yet — but a green check here confirms the MCP server is live and tools
# are registered.
MCP_HEALTH=$(curl -fsS "$BASE/mcp/health" 2>/dev/null || true)
if [[ -n "$MCP_HEALTH" ]]; then
  TOOL_COUNT=$(python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("toolCount", 0))
except: print(0)' <<< "$MCP_HEALTH")
  pass "MCP server live at $BASE/mcp (toolCount=$TOOL_COUNT)"
else
  warn "MCP server not responding at $BASE/mcp — rebuild + restart to pick up the latest build"
fi

# Auto-pick a failing feature if not pinned.
if [[ -z "$FEATURE" ]]; then
  FEATURES_JSON=$(curl -fsS "$BASE/api/features")
  FEATURE=$(python3 -c '
import json, sys
fs = json.load(sys.stdin)
names = [f["name"] for f in fs]
print(next((n for n in names if "broken" in n.lower()), names[0] if names else ""))
' <<< "$FEATURES_JSON")
  if [[ -z "$FEATURE" ]]; then
    die "No features found. Initialise a project first (canary-lab init / new-feature)."
  fi
fi
pass "Using feature: $FEATURE"

if [[ -z "$SESSION_ID" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    SESSION_ID=$(uuidgen | tr 'A-Z' 'a-z')
  else
    SESSION_ID="verify-$(date +%s)-$RANDOM"
  fi
fi
pass "Using sessionId: $SESSION_ID"
info "Client kind: $CLIENT_KIND · Conversation: $CONVERSATION_NAME"

# ─── shared state + cleanup ─────────────────────────────────────────────────
HB_PID=""
RUN_ID=""
TMP_CLAIM_JSON=$(mktemp -t canary-verify-claim.XXXXXX)

stop_heartbeat_loop() {
  if [[ -n "$HB_PID" ]] && kill -0 "$HB_PID" 2>/dev/null; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
  fi
  HB_PID=""
}

cleanup() {
  local rc=$?
  stop_heartbeat_loop
  rm -f "$TMP_CLAIM_JSON" 2>/dev/null || true
  if [[ -n "$RUN_ID" && -z "$KEEP_RUN" ]]; then
    info "Cleaning up run $RUN_ID (set KEEP_RUN=1 to skip)…"
    curl -s -X POST "$BASE/api/runs/$RUN_ID/heal-agent/release" \
      -H 'content-type: application/json' \
      -d "{\"sessionId\":\"$SESSION_ID\"}" >/dev/null || true
    curl -s -X POST "$BASE/api/runs/$RUN_ID/abort" >/dev/null || true
  elif [[ -n "$RUN_ID" && -n "$KEEP_RUN" ]]; then
    info "Leaving run $RUN_ID intact (KEEP_RUN set). Abort manually when done:"
    info "  curl -X POST $BASE/api/runs/$RUN_ID/abort"
  fi
  return $rc
}
trap cleanup EXIT INT TERM

heartbeat() {
  # heartbeat <status>  → prints HTTP code
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$BASE/api/runs/$RUN_ID/heal-agent/heartbeat" \
    -H 'content-type: application/json' \
    -d "{\"sessionId\":\"$SESSION_ID\",\"status\":\"$1\"}"
}

start_heartbeat_loop() {
  # Background loop that keeps the claim fresh while we wait on other things.
  ( while true; do
      curl -s -o /dev/null -X POST "$BASE/api/runs/$RUN_ID/heal-agent/heartbeat" \
        -H 'content-type: application/json' \
        -d "{\"sessionId\":\"$SESSION_ID\",\"status\":\"connected\"}" || true
      sleep 8
    done ) &
  HB_PID=$!
}

run_status() {
  curl -fsS "$BASE/api/runs/$RUN_ID" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("manifest", {}).get("status", ""))
except: print("")'
}

run_state_summary() {
  # Prints "status | phase | headline" so the user can see WHICH stage the
  # orchestrator is parked at (starting-services / running-tests / etc.).
  curl -fsS "$BASE/api/runs/$RUN_ID" | python3 -c '
import json, sys
try:
  m = json.load(sys.stdin).get("manifest", {})
  lc = m.get("lifecycle") or {}
  status = m.get("status", "?")
  phase = lc.get("phase", "?")
  headline = lc.get("headline", "")
  print(status + " | " + phase + " | " + headline)
except: print("?")'
}

external_field() {
  # external_field <key>   → reads manifest.externalHealSession.<key>
  curl -fsS "$BASE/api/runs/$RUN_ID" | python3 -c '
import json, sys
try:
  m = json.load(sys.stdin).get("manifest", {})
  ehs = m.get("externalHealSession") or {}
  print(ehs.get(sys.argv[1], ""))
except: print("")
' "$1"
}

manifest_field() {
  # manifest_field <key>   → reads manifest.<key>
  curl -fsS "$BASE/api/runs/$RUN_ID" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("manifest", {}).get(sys.argv[1], ""))
except: print("")
' "$1"
}

# ─── Step 1: start run with external claim ──────────────────────────────────
banner "Step 1 — Start run with external claim"

START_PAYLOAD=$(
  FEATURE="$FEATURE" \
  SESSION_ID="$SESSION_ID" \
  CLIENT_KIND="$CLIENT_KIND" \
  CONVERSATION_NAME="$CONVERSATION_NAME" \
  python3 -c '
import json, os
print(json.dumps({
  "feature": os.environ["FEATURE"],
  "healAgent": {
    "kind": "external",
    "sessionId": os.environ["SESSION_ID"],
    "clientKind": os.environ["CLIENT_KIND"],
    "conversationName": os.environ["CONVERSATION_NAME"],
  },
}))
')

START_RESP=$(curl -fsS -X POST "$BASE/api/runs" -H 'content-type: application/json' -d "$START_PAYLOAD")
RUN_ID=$(json_get runId "$START_RESP")
[[ -n "$RUN_ID" ]] || die "POST /api/runs returned no runId. Response: $START_RESP"
pass "Run started: $RUN_ID"

# Give the orchestrator a moment to bootstrap the manifest.
sleep 1

HEAL_MODE=$(manifest_field healMode)
if [[ "$HEAL_MODE" == "external" ]]; then
  pass "manifest.healMode = 'external'"
else
  fail "manifest.healMode = '$HEAL_MODE' (expected 'external')"
fi

SESSION_CHECK=$(external_field sessionId)
if [[ "$SESSION_CHECK" == "$SESSION_ID" ]]; then
  pass "manifest.externalHealSession.sessionId matches"
else
  fail "manifest.externalHealSession.sessionId = '$SESSION_CHECK' (expected '$SESSION_ID')"
fi

CLIENT_CHECK=$(external_field clientKind)
[[ "$CLIENT_CHECK" == "$CLIENT_KIND" ]] && pass "clientKind matches" \
  || fail "clientKind = '$CLIENT_CHECK' (expected '$CLIENT_KIND')"

visual "Open $BASE, click run $RUN_ID, then the 'Heal agent' tab."
visual "Expect: 'Healing via Claude Desktop' headline, conversation '$CONVERSATION_NAME', green Connected pill, 'Open Claude Desktop →' CTA."

# ─── Step 2: wait for healing ───────────────────────────────────────────────
banner "Step 2 — Wait for tests to fail and run to enter 'healing'"

# Keep the claim fresh while we wait — the orchestrator can take 10–30s to
# start services + run tests, which would otherwise outlast the 15s stale window.
start_heartbeat_loop
info "Background heartbeat started (PID $HB_PID). Polling every 3s for up to ${WAIT_FOR_HEALING_SECONDS}s (WAIT_FOR_HEALING_SECONDS to override)."

ENTERED=0
LAST_PHASE=""
deadline=$(( $(date +%s) + WAIT_FOR_HEALING_SECONDS ))
while [[ $(date +%s) -lt $deadline ]]; do
  SUMMARY=$(run_state_summary)
  # Only print when the phase changes — keeps the log readable for long runs.
  PHASE=$(echo "$SUMMARY" | awk -F' \\| ' '{print $2}')
  if [[ "$PHASE" != "$LAST_PHASE" ]]; then
    info "  $SUMMARY"
    LAST_PHASE="$PHASE"
  fi
  s=$(echo "$SUMMARY" | awk -F' \\| ' '{print $1}')
  if [[ "$s" == "healing" ]]; then ENTERED=1; break; fi
  if [[ "$s" == "passed" ]]; then
    fail "Run passed unexpectedly. Pick a feature with a failing test (FEATURE=...)."
    exit 1
  fi
  if [[ "$s" == "aborted" ]]; then
    fail "Run aborted before reaching 'healing'."
    # Surface why the orchestrator gave up — usually a service that won't
    # boot, a missing envset, or an unreachable repo path.
    DETAIL=$(curl -fsS "$BASE/api/runs/$RUN_ID" | python3 -c '
import json, sys
try:
  m = json.load(sys.stdin).get("manifest", {})
  lc = m.get("lifecycle") or {}
  reason = lc.get("abortReason") or {}
  print("  phase:    " + str(lc.get("phase", "")))
  print("  headline: " + str(lc.get("headline", "")))
  if lc.get("detail"): print("  detail:   " + str(lc.get("detail", "")))
  if reason:
    print("  abortReason: " + json.dumps(reason))
  # Last 5 lifecycle events for additional context.
  evs = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else []
except Exception as e:
  print("  (could not parse manifest: " + str(e) + ")")
' 2>/dev/null || true)
    [[ -n "$DETAIL" ]] && info "$DETAIL"
    info ""
    info "Next steps:"
    info "  • Re-run with KEEP_RUN=1 to keep the run, then 'open $BASE' and click into it to see the Run Logs / Services tabs."
    info "  • OR pick a feature that boots cleanly:"
    info "      FEATURE=<feature-name> ./tools/verify-external-heal.sh"
    info "  • OR inspect the runner log directly: cat <workspace>/logs/runs/$RUN_ID/runner.log"
    exit 1
  fi
  sleep 3
done

if [[ $ENTERED -eq 1 ]]; then
  pass "Run entered 'healing' state"
else
  fail "Timed out after ${WAIT_FOR_HEALING_SECONDS}s waiting for 'healing'"
  info "  Last lifecycle: $(run_state_summary)"
  info ""
  info "Possible causes:"
  info "  • Services are slow to boot — bump the timeout:"
  info "      WAIT_FOR_HEALING_SECONDS=600 FEATURE=$FEATURE ./tools/verify-external-heal.sh"
  info "  • Tests are passing (no failure → no heal). Try a feature with a known failing test, or"
  info "    temporarily break a test in this feature so a failure triggers the heal loop."
  info "  • Inspect what the run is doing live:"
  info "      open $BASE  → click run $RUN_ID  → look at the Run Logs / Playwright tabs"
  exit 1
fi

# ─── Step 3: heal context ───────────────────────────────────────────────────
banner "Step 3 — Fetch heal-context bundle"
CTX=$(curl -fsS "$BASE/api/runs/$RUN_ID/heal-context")
FAILED_COUNT=$(python3 -c '
import json, sys
print(len(json.load(sys.stdin).get("failedTests", [])))' <<< "$CTX")
if [[ "$FAILED_COUNT" -gt 0 ]]; then
  pass "heal-context returned $FAILED_COUNT failed test(s)"
else
  warn "heal-context returned 0 failed tests — orchestrator may still be writing the summary"
fi

CTX_SESSION=$(python3 -c '
import json, sys
ehs = json.load(sys.stdin).get("externalHealSession") or {}
print(ehs.get("sessionId", ""))' <<< "$CTX")
[[ "$CTX_SESSION" == "$SESSION_ID" ]] && pass "heal-context.externalHealSession.sessionId matches" \
  || fail "session mismatch in heal-context (got '$CTX_SESSION')"

# ─── Step 4: explicit heartbeat ─────────────────────────────────────────────
banner "Step 4 — Explicit heartbeat"
HB_CODE=$(heartbeat healing)
[[ "$HB_CODE" == "204" ]] && pass "Heartbeat → HTTP 204" || fail "Heartbeat → HTTP $HB_CODE (expected 204)"

# Wrong sessionId should be rejected.
WRONG_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/runs/$RUN_ID/heal-agent/heartbeat" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"not-our-session\",\"status\":\"connected\"}")
[[ "$WRONG_CODE" == "409" ]] && pass "Heartbeat with wrong sessionId → HTTP 409" \
  || fail "Heartbeat with wrong sessionId → HTTP $WRONG_CODE (expected 409)"

# ─── Step 5: rerun signal ───────────────────────────────────────────────────
banner "Step 5 — Write a rerun signal"
SIG_RESP=$(curl -fsS -X POST "$BASE/api/runs/$RUN_ID/signal" \
  -H 'content-type: application/json' \
  -d "{\"kind\":\"rerun\",\"body\":{\"reason\":\"verify backbone — no real fix\"},\"sessionId\":\"$SESSION_ID\"}")
SIG_OK=$(json_get accepted "$SIG_RESP")
[[ "$SIG_OK" == "True" || "$SIG_OK" == "true" ]] \
  && pass "Signal accepted: $SIG_RESP" \
  || fail "Signal not accepted: $SIG_RESP"

visual "Watch the panel's lifecycle ribbon — it should add 'Applying signal' → 'Rerunning tests'."

# ─── Step 6: stale-disconnect ───────────────────────────────────────────────
banner "Step 6 — Stale-disconnect (stop heartbeating ~20s)"
stop_heartbeat_loop
info "Background heartbeat stopped. Waiting 20s with no keepalive…"
sleep 20

DISCO=$(external_field status)
if [[ "$DISCO" == "disconnected" ]]; then
  pass "externalHealSession.status = 'disconnected' after 20s"
else
  fail "externalHealSession.status = '$DISCO' (expected 'disconnected')"
fi

visual "Panel should now show a red 'Disconnected' pill and reconnect-tone body copy."

info "Reconnecting with the same sessionId…"
heartbeat connected >/dev/null
sleep 1
RECON=$(external_field status)
if [[ "$RECON" == "connected" ]]; then
  pass "externalHealSession.status flipped back to 'connected'"
else
  fail "externalHealSession.status = '$RECON' (expected 'connected')"
fi

# Resume the background heartbeat so the run stays alive while we finish.
start_heartbeat_loop

# ─── Step 7: single-claim guarantee ─────────────────────────────────────────
banner "Step 7 — Second claim with a different sessionId must be rejected"
ALT_SESSION="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || echo alt-$RANDOM)"
CLAIM_CODE=$(curl -s -o "$TMP_CLAIM_JSON" -w '%{http_code}' \
  -X POST "$BASE/api/runs/$RUN_ID/heal-agent/claim" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$ALT_SESSION\",\"clientKind\":\"codex-cli\"}")
REASON=$(json_get reason "$(cat "$TMP_CLAIM_JSON")")
if [[ "$CLAIM_CODE" == "409" && "$REASON" == "already-claimed" ]]; then
  pass "Second claim rejected with HTTP 409 already-claimed"
else
  fail "Second claim: HTTP $CLAIM_CODE reason='$REASON' (expected 409 already-claimed)"
fi

# Reclaim with original sessionId should be idempotent.
RECLAIM_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/runs/$RUN_ID/heal-agent/claim" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"clientKind\":\"$CLIENT_KIND\"}")
[[ "$RECLAIM_CODE" == "200" ]] && pass "Reclaim with original sessionId → HTTP 200" \
  || fail "Reclaim with original sessionId → HTTP $RECLAIM_CODE (expected 200)"

# ─── summary ────────────────────────────────────────────────────────────────
banner "Summary"
printf '  %s%d passed%s · %s%d failed%s\n' "$C_GREEN" "$PASS" "$C_RESET" "$C_RED" "$FAIL" "$C_RESET"
printf '  Run id: %s\n' "$RUN_ID"

if [[ "$FAIL" -gt 0 ]]; then
  warn "Some automated checks failed. The cleanup trap will release and abort the run."
  exit 1
fi

info ""
info "All automated checks passed. Manual visual checks left for you:"
info "  • ExternalHealPanel renders with monogram + conversation name + session id + status pill + CTA"
info "  • Heartbeat label counts up; turns amber at 10s, red at 15s+ when stalled"
info "  • Lifecycle ribbon updates after the rerun signal"
info "  • 'Disconnected' state shows the reconnect-tone copy"
exit 0
