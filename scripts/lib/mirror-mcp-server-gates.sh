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
  #
  # SMI-6287: each branch used to route its `grep -rl` matches straight to
  # /dev/null — a hit was reported ("found a ...-shaped string") with no way
  # to tell WHICH file(s) tripped it, making this fallback branch just as
  # undiagnosable as gitleaks' own bare "leaks found: 1" was before the
  # --verbose/--report-path fix below. Print the matched filenames instead.
  local hit=false
  local matches

  matches="$(grep -rlE 'sk_live_[A-Za-z0-9]+' "$TREE_DIR" 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    warn "Manual grep found an 'sk_live_'-shaped string in the candidate tree:"$'\n'"$matches"
    hit=true
  fi

  matches="$(grep -rlE '[a-z0-9]{20}\.supabase\.co' "$TREE_DIR" 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    warn "Manual grep found a supabase.co project-ref-shaped string in the candidate tree:"$'\n'"$matches"
    hit=true
  fi

  matches="$(grep -rlE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$TREE_DIR" 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    warn "Manual grep found an email-address-shaped string in the candidate tree:"$'\n'"$matches"
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
    #
    # SMI-6287: --verbose + --report-path make this gate self-diagnosing — a
    # bare failure used to print only "leaks found: N" with no rule id or
    # file/line, which is exactly what let a post-strip path-drift false
    # positive (the mirror's tar --strip-components=2 relocating
    # typosquat-reference-snapshot.json) go undiagnosed sync after sync.
    # Flag names verified against the CI-pinned gitleaks v8.21.2 specifically
    # (`gitleaks detect --help`, both are top-level/global flags on that
    # version — not assumed from a newer/older gitleaks release).
    local report_path="$TMP_ROOT/gitleaks-report.json"
    if ! gitleaks detect --no-git --source "$TREE_DIR" --config "$REPO_ROOT/.gitleaks.toml" \
        --verbose --report-path "$report_path"; then
      if [[ -s "$report_path" ]]; then
        warn "gitleaks report (${report_path}):"
        cat "$report_path" >&2
      fi
      err "gitleaks detected a potential secret in the candidate tree — aborting sync (see rule id/file/line above)"
    fi
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
