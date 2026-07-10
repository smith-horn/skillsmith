#!/usr/bin/env bash
# mirror-mcp-server-gates.sh — leak-audit and build-validity gates for
# scripts/mirror-mcp-server.sh (SMI-5629, change 4). Split out of the main
# script to keep it under the repo's 500-line file standard.
#
# Sourced (not executed) by mirror-mcp-server.sh — relies on that script's
# globals (TREE_DIR, REPO_ROOT, NPM_VERSION) and log/warn/err helpers being
# already defined in the calling shell.

# ---------------------------------------------------------------------------
# Leak audit (change 4) — runs against every candidate tree, every sync, not
# just the one-time pre-first-push manual review.
# ---------------------------------------------------------------------------

run_manual_secret_grep() {
  # Last-resort fallback only, when neither gitleaks nor trufflehog is on
  # PATH. Deliberately coarse — e.g. the email-shaped pattern will also
  # match benign test fixtures like test@example.com — so it will false
  # positive far more often than the dedicated scanners; that's an accepted
  # tradeoff for a fallback, not the primary path (install gitleaks/trufflehog
  # to avoid it).
  local hit=false

  if grep -rlE 'sk_live_[A-Za-z0-9]+' "$TREE_DIR" >/dev/null 2>&1; then
    warn "Manual grep found an 'sk_live_'-shaped string in the candidate tree."
    hit=true
  fi
  if grep -rlE '[a-z0-9]{20}\.supabase\.co' "$TREE_DIR" >/dev/null 2>&1; then
    warn "Manual grep found a supabase.co project-ref-shaped string in the candidate tree."
    hit=true
  fi
  if grep -rlE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$TREE_DIR" >/dev/null 2>&1; then
    warn "Manual grep found an email-address-shaped string in the candidate tree."
    hit=true
  fi

  [[ "$hit" == "false" ]] || err "manual secret-pattern grep found one or more hits — aborting sync (install gitleaks or trufflehog for a precise scan)"
}

check_dist_absolute_paths() {
  # Excludes test files: the published tarball's dist/**/*.test.js fixtures
  # contain synthetic placeholder paths (e.g. /home/user/.claude/skills/...,
  # /Users/test/...) that aren't real build-host leaks — same test-file trust
  # boundary .gitleaks.toml already applies (verified: real shipped code and
  # sourcemaps have zero absolute-path hits; only *.test.js/*.test.js.map do).
  local hits
  hits="$(grep -rlE '(/Users/[A-Za-z]|/home/[A-Za-z]|/private/tmp/)' "$TREE_DIR/dist" 2>/dev/null \
    | grep -vE '(\.test\.js(\.map)?$|/(tests|__tests__)/)' || true)"
  if [[ -n "$hits" ]]; then
    err "absolute build-host path(s) found in dist/ (leaks the build machine's filesystem layout):"$'\n'"$hits"
  fi
}

check_no_dotenv_files() {
  local hits
  hits="$(find "$TREE_DIR" -type f -iname '.env*' 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    err "one or more .env* files survived into the candidate tree:"$'\n'"$hits"
  fi
}

run_leak_audit() {
  log "Running leak audit against the candidate tree..."

  if command -v gitleaks >/dev/null 2>&1; then
    log "Scanning with gitleaks (repo config: ${REPO_ROOT}/.gitleaks.toml)..."
    # Must pass --config: the repo's own .gitleaks.toml already allowlists
    # the known-synthetic secret-scanner test fixtures that git-archived
    # tests/ and the published dist/**/*.test.js otherwise trip on EVERY
    # sync (verified: 25 hits with no --config, 0 with it, against a real
    # assembled tree — see SMI-5629 Opus review). Without this flag the gate
    # is not "aborts on a real leak", it's "aborts on every sync, forever".
    gitleaks detect --no-git --source "$TREE_DIR" --config "$REPO_ROOT/.gitleaks.toml" \
      || err "gitleaks detected a potential secret in the candidate tree — aborting sync"
  elif command -v trufflehog >/dev/null 2>&1; then
    log "gitleaks not found — scanning with trufflehog..."
    # --fail is required: `trufflehog filesystem` exits 0 even when it finds
    # verified secrets unless --fail is passed, so without it this gate never
    # actually aborts. --no-update skips its self-update network call in CI.
    # Note: trufflehog does not honor .gitleaks.toml, so it will FP on the
    # same synthetic fixtures gitleaks is configured to skip — gitleaks is
    # the primary, supported path; this fallback is genuinely last-resort.
    trufflehog filesystem "$TREE_DIR" --fail --no-update \
      || err "trufflehog detected a potential secret in the candidate tree — aborting sync"
  else
    warn "Neither gitleaks nor trufflehog found on PATH — falling back to manual grep patterns."
    run_manual_secret_grep
  fi

  check_dist_absolute_paths
  check_no_dotenv_files

  log "Leak audit passed."
}

# ---------------------------------------------------------------------------
# Build-validity gate (change 4) — must pass before any push, every sync.
# ---------------------------------------------------------------------------
run_build_gate() {
  require_cmd docker
  log "Running build-validity gate (docker build) against the candidate tree..."

  local image_tag="skillsmith-mcp-server-mirror-check:${NPM_VERSION}"
  local build_log="$TMP_ROOT/docker-build.log"

  if ! docker build --tag "$image_tag" "$TREE_DIR" >"$build_log" 2>&1; then
    tail -n 60 "$build_log" >&2
    err "docker build failed against the candidate tree (see build log above) — aborting sync"
  fi

  log "docker build succeeded (${image_tag})."
  docker image rm "$image_tag" >/dev/null 2>&1 || true
}
