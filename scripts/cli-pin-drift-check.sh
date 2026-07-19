#!/usr/bin/env bash
# cli-pin-drift-check.sh (SMI-5746 Wave 3) — scheduled ADVISORY backstop for
# CLI-tool version pins that Dependabot cannot see (standalone npx pins in
# .mcp.json, plus a cheap secondary check on package.json devDependency pins
# for tools that only recently gained Dependabot visibility).
#
# Watches:
#   - .mcp.json's `ruflo` npx pin (primary — the case with NO package.json
#     visibility at all; the pin lives only in a JSON `args` field)
#   - root package.json's `supabase` devDependency pin
#   - packages/website/package.json's `wrangler` devDependency pin
#
# Flags via a deduped, per-tool-titled GitHub issue when a newer MINOR-OR-MAJOR
# version has been available upstream for >30 days, measured from THAT
# version's own publish date (never from latest's — patch churn on the
# current line must never reset the clock). Patch-only gaps are logged to
# state on every run but never page by default — an explicitly documented,
# NOT solved, residual limitation (see the "Patch-only handling" note in
# docs/internal/implementation/cli-tool-version-drift-remediation.md): a
# patch release containing a real security fix (Ruflo's own SMI-5399 history
# is exactly this shape) would not auto-page under this design. The manual
# Ruflo re-audit checklist (docs/internal/architecture/ruflo-tool-classification.md)
# remains the backstop for that case.
#
# NEVER bumps a pin. Flag-only, human review — SMI-5399 precedent (an
# automated bump pulled a @claude-flow/cli tree with 9 high-severity
# transitive vulns past the npm audit CI gate).
#
# Called by scripts/eval-baseline-cron.sh as a best-effort post-eval step,
# appended AFTER the existing retrieval-liveness-check.sh call, and wrapped
# by the caller in `timeout 120` (this script also applies its own `timeout 15`
# to each individual npm view / gh network call, so no single hung call can
# block the others or delay the eval cron's own heartbeat bookkeeping).
#
# Usage:
#   ./scripts/cli-pin-drift-check.sh
#
# Exit code: always 0 (best-effort — matches the `|| true` calling convention
#            already used for retrieval-liveness-check.sh; internal failures
#            are logged, never propagated as a hard fail).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${SKILLSMITH_CLI_PIN_DRIFT_HOME:-$HOME}/.skillsmith"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/cli-pin-drift-$(date +%Y-%m-%d).log"
STATE_FILE="$STATE_DIR/cli-pin-drift.state"

VAR_DISABLE="SKILLSMITH_CLI_PIN_DRIFT_DISABLE"
VAR_SHADOW="SKILLSMITH_CLI_PIN_DRIFT_SHADOW"

GRACE_DAYS="${SKILLSMITH_CLI_PIN_DRIFT_GRACE_DAYS:-30}"
[[ "$GRACE_DAYS" =~ ^[0-9]+$ ]] || GRACE_DAYS=30
COOLDOWN_DAYS=14

log() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

if [ "${SKILLSMITH_CLI_PIN_DRIFT_DISABLE:-}" = "1" ]; then
  log "[cli-pin-drift] skip: disabled (${VAR_DISABLE}=1)"
  exit 0
fi

for bin in jq npm node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "[cli-pin-drift] probe-failed: $bin not on PATH"
    exit 0
  fi
done

mkdir -p "$STATE_DIR" 2>/dev/null || true
[ -f "$STATE_FILE" ] || echo '{}' >"$STATE_FILE"

# --- portable per-call timeout (SMI-4700: macOS ships neither GNU `timeout`
#     nor `gtimeout` by default) -------------------------------------------------
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1 && gtimeout --kill-after=0 0 true >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1 && timeout --kill-after=0 0 true >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi
run_with_timeout() {
  local seconds="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$seconds" "$@"
  else
    "$@" # neither timeout binary available — run unbounded rather than fail
  fi
}

# --- gh wrapper (test seam, mirrors retrieval-liveness-check.sh's convention) --
run_gh() {
  if [ "${SKILLSMITH_CLI_PIN_DRIFT_TEST:-}" = "1" ] && [ -n "${SKILLSMITH_CLI_PIN_DRIFT_GH_CMD:-}" ]; then
    bash "${SKILLSMITH_CLI_PIN_DRIFT_GH_CMD}" "$@"
    return $?
  fi
  gh "$@"
}

# --- atomic state write (temp file + rename, never in-place) -------------------
write_state_json() {
  local new_json="$1"
  local tmp
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
  printf '%s' "$new_json" >"$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_get() {
  jq -r --arg t "$1" --arg f "$2" '.[$t][$f] // empty' "$STATE_FILE" 2>/dev/null || true
}

# --- npm view with a hard per-call timeout --------------------------------------
npm_view() {
  run_with_timeout 15 npm view "$@" 2>/dev/null || true
}

# --- find the first published version strictly newer than $pinned that bumps
#     minor or major (not just patch) -------------------------------------------
first_newer_minor_or_major() {
  local pinned="$1" versions_json="$2"
  node -e '
    const versions = JSON.parse(process.argv[1] || "[]");
    const pinned = process.argv[2];
    const cmp = (a, b) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
      return 0;
    };
    const [pMajor, pMinor] = pinned.split(".").map(Number);
    const candidates = versions
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .filter(v => cmp(v, pinned) > 0)
      .filter(v => { const [ma, mi] = v.split(".").map(Number); return ma !== pMajor || mi !== pMinor; })
      .sort(cmp);
    console.log(candidates[0] || "");
  ' "$versions_json" "$pinned" 2>/dev/null || echo ""
}

days_since() {
  local iso="$1"
  [ -z "$iso" ] && { echo "0"; return; }
  node -e "console.log(Math.max(0, Math.floor((Date.now()-Date.parse(process.argv[1]))/864e5)))" -- "$iso" 2>/dev/null || echo "0"
}

# --- open/update a deduped, per-tool-titled GitHub issue ------------------------
page_tool() {
  local tool="$1" pinned="$2" first_newer="$3" age_days="$4"

  local last_notified now_epoch cooldown_secs
  last_notified="$(state_get "$tool" last_notified_at)"
  now_epoch="$(date +%s)"
  cooldown_secs=$((COOLDOWN_DAYS * 86400))
  if [ -n "$last_notified" ]; then
    local last_epoch
    last_epoch="$(node -e "console.log(Math.floor(Date.parse(process.argv[1])/1000)||0)" -- "$last_notified" 2>/dev/null || echo 0)"
    if [ "$last_epoch" -gt 0 ] && [ $((now_epoch - last_epoch)) -lt "$cooldown_secs" ]; then
      log "[cli-pin-drift] $tool: within ${COOLDOWN_DAYS}-day re-notify cooldown; no gh action"
      return
    fi
  fi

  local shadow="${SKILLSMITH_CLI_PIN_DRIFT_SHADOW:-1}"
  local title="CLI pin drift: ${tool}"
  local label="cli-pin-drift"
  local body="## CLI-tool version drift: \`${tool}\`

**Pinned:** \`${pinned}\`
**First newer minor/major:** \`${first_newer}\` (this checker has observed the gap for ~${age_days} days — age is tracked from when this script first noticed it, not from npm's own publish-date metadata, which was found unreliable for at least one watched package during implementation)

This pin lives outside \`package.json\` (or is otherwise invisible to Dependabot's normal lockfile scan) and must be reviewed by a human before bumping — this checker never bumps automatically (SMI-5399: an automated Ruflo bump previously pulled a transitive tree with 9 high-severity vulnerabilities past the \`npm audit\` CI gate).

### Review pointers
- Ruflo: \`docs/internal/architecture/ruflo-tool-classification.md\` (Re-audit procedure)
- Supabase CLI: Linear SMI-4360
- Wrangler: root \`packages/website/package.json\` devDependency

_Auto-generated by \`scripts/cli-pin-drift-check.sh\`. Re-notify in ~${COOLDOWN_DAYS} days if unresolved. Disable: \`${VAR_DISABLE}=1\`. Shadow: \`${VAR_SHADOW}\` (default on)._"

  if [ "$shadow" = "1" ]; then
    log "[cli-pin-drift] $tool: [shadow] WOULD open/update issue: ${title}"
    write_state_json "$(jq --arg t "$tool" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.[$t].last_notified_at = $now' "$STATE_FILE")"
    return
  fi

  local existing
  existing="$(run_gh issue list --label "$label" --state open --json number,title \
    -q ".[] | select(.title == \"${title}\") | .number" 2>/dev/null | head -1 || echo "")"

  if [ -n "${existing:-}" ]; then
    log "[cli-pin-drift] $tool: commenting on existing issue #${existing}"
    run_gh issue comment "$existing" --body "Still drifted: pinned \`${pinned}\`, first newer minor/major \`${first_newer}\` (~${age_days}d)." 2>/dev/null \
      || log "[cli-pin-drift] $tool: warn: gh issue comment failed for #${existing}"
    write_state_json "$(jq --arg t "$tool" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg n "$existing" \
      '.[$t].last_notified_at = $now | .[$t].github_issue_number = ($n|tonumber)' "$STATE_FILE")"
  else
    log "[cli-pin-drift] $tool: creating new issue: ${title}"
    local new_url new_num
    new_url="$(run_gh issue create --label "$label" --title "$title" --body "$body" 2>/dev/null || echo "")"
    new_num="$(printf '%s' "$new_url" | sed -n 's#.*/issues/\([0-9][0-9]*\).*#\1#p' | head -1)"
    if [ -n "${new_num:-}" ]; then
      log "[cli-pin-drift] $tool: created issue #${new_num} (${new_url})"
      write_state_json "$(jq --arg t "$tool" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg n "$new_num" \
        '.[$t].last_notified_at = $now | .[$t].github_issue_number = ($n|tonumber)' "$STATE_FILE")"
    else
      log "[cli-pin-drift] $tool: warn: gh issue create failed or URL unparsed (${new_url:-empty})"
    fi
  fi
}

# --- per-tool check --------------------------------------------------------------
# args: <tool-name> <pinned-version>
check_tool() {
  local tool="$1" pinned="$2"
  if [ -z "$pinned" ]; then
    log "[cli-pin-drift] $tool: no pin found, skipping"
    return
  fi

  local latest
  latest="$(npm_view "$tool" version)"
  if [ -z "$latest" ]; then
    log "[cli-pin-drift] $tool: npm view failed or timed out, skipping"
    return
  fi

  local prev_last_notified prev_issue prev_first_newer prev_first_observed_at
  prev_last_notified="$(state_get "$tool" last_notified_at)"
  prev_issue="$(state_get "$tool" github_issue_number)"
  prev_first_newer="$(state_get "$tool" first_newer_minor_or_major)"
  prev_first_observed_at="$(state_get "$tool" first_observed_at)"

  if [ "$latest" = "$pinned" ]; then
    log "[cli-pin-drift] $tool: up to date ($pinned)"
    write_state_json "$(jq --arg t "$tool" --arg p "$pinned" --arg l "$latest" \
      --arg ln "$prev_last_notified" --arg gi "$prev_issue" \
      '.[$t] = {pinned:$p, latest:$l, first_newer_minor_or_major:null, first_observed_at:null,
                 last_notified_at:(if $ln=="" then null else $ln end),
                 github_issue_number:(if $gi=="" then null else ($gi|tonumber) end)}' \
      "$STATE_FILE")"
    return
  fi

  local versions_json first_newer
  versions_json="$(npm_view "$tool" versions --json)"
  [ -z "$versions_json" ] && versions_json="[]"
  first_newer="$(first_newer_minor_or_major "$pinned" "$versions_json")"

  # Age is tracked from when THIS CHECKER first observed the current drift
  # target, not from npm's own publish-date metadata: a real production
  # anomaly was found during implementation where `npm view <pkg>@<version>
  # time.created` returned a date years before the package's own earlier
  # versions, which would have caused an immediate false-positive page the
  # moment shadow mode lifted. Self-referential dating only needs this
  # machine's own clock to be monotonic, which weekly-cron wall-clock time
  # always is — and it naturally resets if $first_newer changes (the pin
  # moved, or a newer minor/major superseded the one being tracked).
  local first_observed_at age_days
  if [ -n "$first_newer" ] && [ "$first_newer" = "$prev_first_newer" ] && [ -n "$prev_first_observed_at" ]; then
    first_observed_at="$prev_first_observed_at"
  elif [ -n "$first_newer" ]; then
    first_observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    first_observed_at=""
  fi
  age_days="$(days_since "$first_observed_at")"

  write_state_json "$(jq --arg t "$tool" --arg p "$pinned" --arg l "$latest" \
    --arg fn "$first_newer" --arg fo "$first_observed_at" \
    --arg ln "$prev_last_notified" --arg gi "$prev_issue" \
    '.[$t] = {pinned:$p, latest:$l,
               first_newer_minor_or_major:(if $fn=="" then null else $fn end),
               first_observed_at:(if $fo=="" then null else $fo end),
               last_notified_at:(if $ln=="" then null else $ln end),
               github_issue_number:(if $gi=="" then null else ($gi|tonumber) end)}' \
    "$STATE_FILE")"

  if [ -z "$first_newer" ]; then
    log "[cli-pin-drift] $tool: pinned $pinned, latest $latest, no newer minor/major (patch-only gap) — logged, not paged"
    return
  fi

  log "[cli-pin-drift] $tool: pinned $pinned, first newer minor/major $first_newer (first observed $first_observed_at, ${age_days}d ago)"

  if [ "$age_days" -lt "$GRACE_DAYS" ]; then
    log "[cli-pin-drift] $tool: within ${GRACE_DAYS}-day grace period, not paging yet"
    return
  fi

  page_tool "$tool" "$pinned" "$first_newer" "$age_days"
}

# --- resolve pins from the live repo (not hardcoded) ----------------------------
RUFLO_PIN="$(jq -r '.mcpServers.ruflo.args[0] // empty' "$REPO_ROOT/.mcp.json" 2>/dev/null | sed -n 's/^ruflo@//p')"
SUPABASE_PIN="$(jq -r '.devDependencies.supabase // empty' "$REPO_ROOT/package.json" 2>/dev/null)"
WRANGLER_PIN="$(jq -r '.devDependencies.wrangler // empty' "$REPO_ROOT/packages/website/package.json" 2>/dev/null)"

check_tool "ruflo" "$RUFLO_PIN"
check_tool "supabase" "$SUPABASE_PIN"
check_tool "wrangler" "$WRANGLER_PIN"

exit 0
