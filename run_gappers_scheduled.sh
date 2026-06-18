#!/usr/bin/env bash
#
# run_gappers_scheduled.sh — guarded wrapper invoked by Windows Task Scheduler.
#
# Decides whether a premarket scan should actually run RIGHT NOW, then runs it.
# All time logic is in America/New_York (handled by `TZ=... date`, DST-aware) so
# it is correct regardless of the laptop's local timezone (this machine is
# Jakarta / UTC+7).
#
# Fires the scan only when ALL of these hold:
#   * NY weekday (Mon-Fri)                      -> skip weekends
#   * START_ET <= now_ET < STALE_AFTER_ET       -> 08:30-09:30 ET window
#                                                  (after the open = premarket stale, skip)
#   * today's NY-dated output file absent       -> at most one run per day
#
# The OS scheduler is configured to "poke" this wrapper repeatedly through the
# morning + on logon + as-soon-as-possible after a missed (asleep) start; this
# wrapper is the single source of truth for whether to act.
#
# Test hooks (no live scan):
#   FAKE_NOW_ET="YYYY-MM-DD HHMM D"  override now (D = NY weekday 1..7)
#   DRY_RUN=1                        log "would run" instead of scanning
#
# Env knobs: START_ET=0830  STALE_AFTER_ET=0930  REPO=<dir>

set -euo pipefail

REPO=${REPO:-/c/Users/kevin/tradingview-mcp}
cd "$REPO"

# Make sure claude + python resolve even under Task Scheduler's bare environment.
export PATH="$PATH:/c/Users/kevin/AppData/Roaming/npm:/c/Users/kevin/AppData/Local/Programs/Python/Python314"

LOG="$REPO/scheduler.log"
START_ET=${START_ET:-0830}
STALE_AFTER_ET=${STALE_AFTER_ET:-0930}
SLACK_CHANNEL=${SLACK_CHANNEL:-C0BB0MRB0FM}                  # #investment-research-hackathon
SLACK_TOKEN_FILE=${SLACK_TOKEN_FILE:-$REPO/.slack_token}     # gitignored; one line: xoxb-...
SLACK_WEBHOOK_FILE=${SLACK_WEBHOOK_FILE:-$REPO/.slack_webhook} # gitignored; one line: https://hooks.slack.com/...
DIGEST="$REPO/gappers_digest.md"                            # local fallback log (append-only)
LATEST="$REPO/latest_gappers.json"                          # local fallback: copy of most recent scan

logline() { printf '%s | %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"; }

# Post to Slack via slack_notify.py. Token from $SLACK_BOT_TOKEN or .slack_token.
# Never fatal: a Slack failure must not fail the scan. Returns nonzero on problems.
slack_notify() {
  local tok="${SLACK_BOT_TOKEN:-}"
  [[ -z "$tok" && -f "$SLACK_TOKEN_FILE" ]] && tok=$(tr -d ' \r\n' < "$SLACK_TOKEN_FILE")
  if [[ -z "$tok" ]]; then
    logline "slack: no token (set SLACK_BOT_TOKEN or create $SLACK_TOKEN_FILE) — skipped"
    return 1
  fi
  SLACK_BOT_TOKEN="$tok" python "$REPO/slack_notify.py" --channel "$SLACK_CHANNEL" "$@" >>"$LOG" 2>&1
}

# Tier 2: Slack incoming webhook (text only, no token). Args forwarded to
# slack_notify.py (e.g. --text "..." or --from-json file). Nonzero if no URL.
webhook_post() {
  local url="${SLACK_WEBHOOK_URL:-}"
  [[ -z "$url" && -f "$SLACK_WEBHOOK_FILE" ]] && url=$(tr -d ' \r\n' < "$SLACK_WEBHOOK_FILE")
  [[ -z "$url" ]] && return 1
  python "$REPO/slack_notify.py" --webhook "$url" "$@" >>"$LOG" 2>&1
}

# Tier 3: best-effort desktop notification (never fatal).
toast() {
  command -v powershell.exe >/dev/null 2>&1 || return 1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$REPO/toast.ps1")" -Message "$1" >/dev/null 2>&1 || true
}

# Tier 3: persistent local record + toast. Always succeeds.
fallback_notify() {
  local msg="$1" file="${2:-}"
  printf '%s | %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$msg" >> "$DIGEST"
  [[ -n "$file" && -f "$file" ]] && cp -f "$file" "$LATEST"
  logline "fallback: appended gappers_digest.md$([[ -n $file && -f $file ]] && echo ' + updated latest_gappers.json')"
  toast "$msg"
}

# Success delivery: best tier available (token file -> webhook -> local).
deliver_success() {
  local summary="$1" file="$2"
  # Slack message is always the human-readable render of the JSON; the JSON file
  # itself is attached only on the bot-token path (webhooks/MCP can't attach files).
  if slack_notify --from-json "$file" --file "$file"; then
    logline "delivered: Slack message + JSON file -> $SLACK_CHANNEL"
  elif webhook_post --from-json "$file"; then
    logline "delivered: Slack webhook message (JSON kept locally; webhooks can't attach files)"
    fallback_notify "$summary" "$file"
  else
    logline "delivered: local fallback only (no Slack creds)"
    fallback_notify "$summary" "$file"
  fi
}

# Failure alert: best tier available.
deliver_failure() {
  local msg="$1"
  if slack_notify --text "$msg"; then logline "failure alert: Slack";
  elif webhook_post --text "$msg"; then logline "failure alert: Slack webhook";
  else logline "failure alert: local fallback"; fallback_notify "$msg" ""; fi
}

# --test-notify: exercise the delivery tiering (token->webhook->local) with a
# sample summary + file, no scan. Lets you see which tier fires + the fallback.
if [[ "${1:-}" == "--test-notify" ]]; then
  tmp="$REPO/premarket_gappers_TEST.json"
  printf '{"scanned_at":"TEST","gappers":[]}\n' > "$tmp"
  logline "test-notify: exercising delivery tiers"
  deliver_success "Premarket Gappers (TEST): delivery check — ignore." "$tmp"
  rm -f "$tmp"
  echo "test-notify done; see scheduler.log"
  exit 0
fi

# NY time via Python zoneinfo (DST-aware). This MSYS bash has NO IANA tz db, so
# `TZ=America/New_York date` silently returns UTC — do NOT use it. Requires the
# `tzdata` pip package (pure-Python IANA db).
if [[ -n "${FAKE_NOW_ET:-}" ]]; then
  NY_DATE="${FAKE_NOW_ET%% *}"; rest="${FAKE_NOW_ET#* }"
  NY_HHMM="${rest%% *}"; NY_DOW="${rest##* }"
else
  ny=$(python -c "from datetime import datetime; from zoneinfo import ZoneInfo; n=datetime.now(ZoneInfo('America/New_York')); print(n.strftime('%Y-%m-%d %H%M'), n.isoweekday())" 2>/dev/null | tr -d '\r')
  read -r NY_DATE NY_HHMM NY_DOW <<<"$ny"
  if [[ -z "${NY_DATE:-}" || -z "${NY_HHMM:-}" || -z "${NY_DOW:-}" ]]; then
    logline "ABORT: could not compute NY time (is the 'tzdata' pip package installed?)"
    exit 1
  fi
fi

# numeric forms (10# avoids octal interpretation of leading-zero times)
hhmm=$((10#$NY_HHMM)); start=$((10#$START_ET)); stale=$((10#$STALE_AFTER_ET))
OUT="$REPO/premarket_gappers_${NY_DATE}.json"

if (( NY_DOW > 5 )); then
  logline "skip: weekend (NY $NY_DATE, dow=$NY_DOW)"; exit 0
fi
if (( hhmm < start )); then
  logline "skip: before window (NY $NY_HHMM < $START_ET)"; exit 0
fi
if (( hhmm >= stale )); then
  logline "skip: premarket stale (NY $NY_HHMM >= $STALE_AFTER_ET cutoff)"; exit 0
fi
if [[ -f "$OUT" ]]; then
  logline "skip: already ran today ($(basename "$OUT") exists)"; exit 0
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  logline "RUN (dry-run): would scan for NY $NY_DATE at $NY_HHMM ET"
  echo "DRY_RUN: guards passed — would run scan for $NY_DATE"
  exit 0
fi

logline "RUN: starting scan (NY $NY_DATE $NY_HHMM ET)"
# scanner prints the one-line summary to stdout; its [HH:MM] logs go to stderr->LOG
if summary=$(SCAN_DATE="$NY_DATE" bash "$REPO/premarket_gappers.sh" 2>>"$LOG"); then
  printf '%s\n' "$summary" >> "$LOG"
  logline "DONE: wrote $(basename "$OUT")"
  [[ -z "$summary" ]] && summary="Premarket Gappers scan complete ($NY_DATE)"
  deliver_success "$summary" "$OUT"
else
  rc=$?
  logline "FAIL: scanner exited $rc"
  deliver_failure ":rotating_light: Premarket gappers scan FAILED for $NY_DATE (exit $rc). Check scheduler.log on the laptop."
  exit $rc
fi
