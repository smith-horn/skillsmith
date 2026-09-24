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
# Deliberately depends on node only for JSON handling (no jq) — node is
# already a hard requirement for the version-comparison logic below, and this
# script must run correctly both on the canonical-dev host (where jq happens
# to be present) and inside a CI/Docker container image that does not
# necessarily ship jq (confirmed during implementation: this repo's own dev
# container image does not).
#
# Usage:
#   ./scripts/cli-pin-drift-check.sh
#
# Exit code: 0 for every soft-fail condition (best-effort — matches the
#            `|| true` calling convention already used for
#            retrieval-liveness-check.sh; internal failures are logged,
#            never propagated as a hard fail) -- EXCEPT two: a missing or
#            non-semver RUFLO_CLI_PIN in scripts/mcp-ruflo-launcher.sh
#            (SMI-6744 ADR-170 § 7), and (SMI-6744 M-3, post-merge governance
#            retro on PR #2931) that same pin disagreeing with
#            scripts/ruflo-seed/package.json's own
#            dependencies["@claude-flow/cli"] -- the SECOND committed copy
#            that actually determines what ships in the ruflo image stage.
#            Both pins live in committed files this script can always read;
#            their absence or disagreement is drift, not an environment
#            condition to shrug off, and this is the one path through this
#            script where "no pin found, skipping" is wrong. Both exit 1
#            paths happen only at the very end, AFTER the supabase/wrangler
#            checks below have run and AFTER the finding has been routed
#            through page_tool like any other drift finding (SMI-6744 M-11 —
#            see the comment at the actual check, below, for why an earlier
#            version of this exited immediately instead).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Test seam: lets tests point pin-reading at a fixture directory instead of
# this real checkout, so tests are deterministic and don't depend on this
# repo's own current pin values ever changing.
if [ "${SKILLSMITH_CLI_PIN_DRIFT_TEST:-}" = "1" ] && [ -n "${SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT:-}" ]; then
  REPO_ROOT="$SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT"
fi

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

for bin in npm node; do
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

# --- JSON state helpers (node, not jq — see header note) ------------------------
# json_str: shell-safe JSON-encode a string for use as a state_set raw value.
json_str() {
  node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"
}

# state_get <tool> <field> — empty string if absent/null/unparseable.
state_get() {
  node -e '
    const fs = require("fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const v = state[process.argv[2]] && state[process.argv[2]][process.argv[3]];
      console.log(v === undefined || v === null ? "" : v);
    } catch { console.log(""); }
  ' "$STATE_FILE" "$1" "$2" 2>/dev/null || true
}

# state_set <tool> <field> <raw-json-literal> — atomic (temp file + rename).
# Only touches the one field; every other field on the tool (and every other
# tool) is preserved untouched, so callers never need to read-modify-write a
# whole object just to update one field.
state_set() {
  local tool="$1" field="$2" raw_value="$3"
  local tmp
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")" || return 1
  if node -e '
    const fs = require("fs");
    let state = {};
    try { state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    if (typeof state !== "object" || state === null) state = {};
    const tool = process.argv[2];
    if (typeof state[tool] !== "object" || state[tool] === null) state[tool] = {};
    state[tool][process.argv[3]] = JSON.parse(process.argv[4]);
    fs.writeFileSync(process.argv[5], JSON.stringify(state));
  ' "$STATE_FILE" "$tool" "$field" "$raw_value" "$tmp"; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

# --- npm view with a hard per-call timeout --------------------------------------
# Test seam (mirrors run_gh): lets tests substitute a fake npm script so
# version-drift scenarios are deterministic and don't depend on live
# registry state or network access.
npm_view() {
  if [ "${SKILLSMITH_CLI_PIN_DRIFT_TEST:-}" = "1" ] && [ -n "${SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD:-}" ]; then
    run_with_timeout 15 bash "${SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD}" view "$@" 2>/dev/null || true
    return
  fi
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
  local now_iso
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
    state_set "$tool" last_notified_at "$(json_str "$now_iso")"
    return
  fi

  local existing
  existing="$(run_gh issue list --label "$label" --state open --json number,title \
    -q ".[] | select(.title == \"${title}\") | .number" 2>/dev/null | head -1 || echo "")"

  if [ -n "${existing:-}" ]; then
    log "[cli-pin-drift] $tool: commenting on existing issue #${existing}"
    run_gh issue comment "$existing" --body "Still drifted: pinned \`${pinned}\`, first newer minor/major \`${first_newer}\` (~${age_days}d)." 2>/dev/null \
      || log "[cli-pin-drift] $tool: warn: gh issue comment failed for #${existing}"
    state_set "$tool" last_notified_at "$(json_str "$now_iso")"
    state_set "$tool" github_issue_number "$existing"
  else
    log "[cli-pin-drift] $tool: creating new issue: ${title}"
    local new_url new_num
    new_url="$(run_gh issue create --label "$label" --title "$title" --body "$body" 2>/dev/null || echo "")"
    new_num="$(printf '%s' "$new_url" | sed -n 's#.*/issues/\([0-9][0-9]*\).*#\1#p' | head -1)"
    if [ -n "${new_num:-}" ]; then
      log "[cli-pin-drift] $tool: created issue #${new_num} (${new_url})"
      state_set "$tool" last_notified_at "$(json_str "$now_iso")"
      state_set "$tool" github_issue_number "$new_num"
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

  state_set "$tool" pinned "$(json_str "$pinned")"
  state_set "$tool" latest "$(json_str "$latest")"

  if [ "$latest" = "$pinned" ]; then
    log "[cli-pin-drift] $tool: up to date ($pinned)"
    state_set "$tool" first_newer_minor_or_major null
    state_set "$tool" first_observed_at null
    return
  fi

  local prev_first_newer prev_first_observed_at
  prev_first_newer="$(state_get "$tool" first_newer_minor_or_major)"
  prev_first_observed_at="$(state_get "$tool" first_observed_at)"

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

  if [ -n "$first_newer" ]; then
    state_set "$tool" first_newer_minor_or_major "$(json_str "$first_newer")"
    state_set "$tool" first_observed_at "$(json_str "$first_observed_at")"
  else
    state_set "$tool" first_newer_minor_or_major null
    state_set "$tool" first_observed_at null
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
read_json_field() {
  node -e '
    const fs = require("fs");
    try {
      const obj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let v = obj;
      for (const key of process.argv[2].split(".")) {
        v = v && typeof v === "object" ? v[key] : undefined;
      }
      console.log(v === undefined || v === null ? "" : v);
    } catch { console.log(""); }
  ' "$1" "$2" 2>/dev/null || true
}

# SMI-6744 ADR-170 § 7: the ruflo pin moved out of .mcp.json's npx entry
# (retired — ruflo is now scripts/mcp-ruflo-launcher.sh, which docker execs
# into an image-baked tree) into one RUFLO_CLI_PIN=<semver> assignment in
# that launcher script. Read with an anchored, semver-validating regex —
# the same shape scripts/audit-cli-pin-drift-helpers.mjs Check 59 reads.
#
# This one pin is NOT "no pin found, skipping" when absent or malformed —
# unlike every other soft-fail path in this script (see the header's
# "Exit code: always 0" note), an absent or non-semver RUFLO_CLI_PIN in a
# COMMITTED file is itself the drift this script exists to catch, not an
# environment/network condition to shrug off. Supabase/wrangler below keep
# the original soft-fail behavior unchanged.
#
# SMI-6744 M-11 (governance review, 2026-09-23): this branch used to `exit 1`
# immediately, BEFORE SUPABASE_PIN/WRANGLER_PIN were even read and before any
# check_tool/notify call ran — one missing/malformed ruflo pin silently
# disabled the supabase and wrangler drift checks too, and the script's only
# caller (scripts/eval-baseline-cron.sh) wraps the call in `|| true`, so that
# exit 1 was swallowed by the caller with no other effect. Fixed: set a flag,
# let every other check run, route this finding through the SAME page_tool
# notify path every other drift finding uses (so it reaches the deduped
# `cli-pin-drift` GitHub issue — that is the surface something downstream
# actually consumes, not this script's own log file), and exit 1 only at the
# very end, once nothing else has been skipped because of it.
RUFLO_PIN_MISSING=0
RUFLO_LAUNCHER="$REPO_ROOT/scripts/mcp-ruflo-launcher.sh"
RUFLO_PIN=""
if [ -f "$RUFLO_LAUNCHER" ]; then
  RUFLO_PIN="$(grep -E '^RUFLO_CLI_PIN=[0-9]+\.[0-9]+\.[0-9]+$' "$RUFLO_LAUNCHER" 2>/dev/null | head -1 | sed 's/^RUFLO_CLI_PIN=//')"
fi
if [ -z "$RUFLO_PIN" ]; then
  RUFLO_PIN_MISSING=1
  log "[cli-pin-drift] ruflo: RUFLO_CLI_PIN not found or not valid semver in $RUFLO_LAUNCHER"
  echo "[cli-pin-drift] ruflo: RUFLO_CLI_PIN not found or not valid semver in $RUFLO_LAUNCHER" >&2
  page_tool "ruflo" "(missing)" "N/A -- RUFLO_CLI_PIN not found or not valid semver in $RUFLO_LAUNCHER" 0
fi

# SMI-6744 M-3 (post-merge governance retro, PR #2931): the launcher's pin
# can be well-formed (the check above passes) while still having drifted
# apart from the OTHER committed copy that determines what actually ships in
# the ruflo image -- scripts/ruflo-seed/package.json's own
# dependencies["@claude-flow/cli"]. Mirrors
# scripts/audit-cli-pin-drift-helpers.mjs's findRufloSeedPinDrift(). Only
# checked when the launcher pin itself was found (RUFLO_PIN_MISSING=0);
# otherwise there is nothing valid to compare the seed pin against.
RUFLO_SEED_PACKAGE_JSON="$REPO_ROOT/scripts/ruflo-seed/package.json"
RUFLO_SEED_PIN_MISMATCH=0
if [ "$RUFLO_PIN_MISSING" -eq 0 ]; then
  RUFLO_SEED_PIN="$(read_json_field "$RUFLO_SEED_PACKAGE_JSON" "dependencies.@claude-flow/cli")"
  if [ -z "$RUFLO_SEED_PIN" ]; then
    RUFLO_SEED_PIN_MISMATCH=1
    log "[cli-pin-drift] ruflo-seed: $RUFLO_SEED_PACKAGE_JSON has no dependencies[\"@claude-flow/cli\"] entry"
    echo "[cli-pin-drift] ruflo-seed: $RUFLO_SEED_PACKAGE_JSON has no dependencies[\"@claude-flow/cli\"] entry" >&2
    page_tool "ruflo-seed-drift" "$RUFLO_PIN" "N/A -- $RUFLO_SEED_PACKAGE_JSON has no dependencies[\"@claude-flow/cli\"] entry" 0
  elif [ "$RUFLO_SEED_PIN" != "$RUFLO_PIN" ]; then
    RUFLO_SEED_PIN_MISMATCH=1
    log "[cli-pin-drift] ruflo-seed: RUFLO_CLI_PIN=$RUFLO_PIN in $RUFLO_LAUNCHER does not match dependencies[\"@claude-flow/cli\"]=$RUFLO_SEED_PIN in $RUFLO_SEED_PACKAGE_JSON"
    echo "[cli-pin-drift] ruflo-seed: RUFLO_CLI_PIN=$RUFLO_PIN in $RUFLO_LAUNCHER does not match dependencies[\"@claude-flow/cli\"]=$RUFLO_SEED_PIN in $RUFLO_SEED_PACKAGE_JSON" >&2
    page_tool "ruflo-seed-drift" "$RUFLO_PIN" "$RUFLO_SEED_PIN (from $RUFLO_SEED_PACKAGE_JSON)" 0
  fi
fi

SUPABASE_PIN="$(read_json_field "$REPO_ROOT/package.json" "devDependencies.supabase")"
WRANGLER_PIN="$(read_json_field "$REPO_ROOT/packages/website/package.json" "devDependencies.wrangler")"

# Only run the ruflo version-drift check when a valid pin was actually read —
# check_tool would otherwise just log its own generic "no pin found,
# skipping" for the same tool page_tool just paged above, which is harmless
# but redundant. supabase/wrangler always run regardless (that is the fix).
if [ "$RUFLO_PIN_MISSING" -eq 0 ]; then
  check_tool "ruflo" "$RUFLO_PIN"
fi
check_tool "supabase" "$SUPABASE_PIN"
check_tool "wrangler" "$WRANGLER_PIN"

if [ "$RUFLO_PIN_MISSING" -eq 1 ] || [ "$RUFLO_SEED_PIN_MISMATCH" -eq 1 ]; then
  exit 1
fi

exit 0
