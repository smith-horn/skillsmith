#!/usr/bin/env bash
# mirror-mcp-server.sh — sync packages/mcp-server into the public, submodule-free
# mirror repo smith-horn/skillsmith-mcp-server (SMI-5629).
#
# Why this exists: Docker's MCP registry build tooling does a *full* git clone
# of source.project before assembling the source.directory build context, so
# it recurses into our root .gitmodules and fails on our private submodules.
# The fix is a small public mirror containing only packages/mcp-server, kept
# in sync by this script. See docs/internal/implementation/mcp-server-mirror-repo.md
# for the full design (decisions 1-5 referenced below by number).
#
# Content sources (decision 1): the mirror tree is assembled from TWO sources,
# not a curated subset —
#   (a) a full `git archive` of packages/mcp-server/ at SOURCE_COMMIT (every
#       git-tracked file: src, tests, Dockerfile, package.json, README, etc.)
#   (b) dist/ extracted from the PUBLISHED npm tarball for
#       @skillsmith/mcp-server@<version> — not a fresh build of HEAD, which
#       would reintroduce the semver-drift crash this design avoids.
# Plus overlay files added by this script itself: root LICENSE, a locked
# README banner, and a PR auto-close workflow for the mirror repo.
#
# History model (decision 3): append-only. Each sync adds exactly ONE new
# commit to the mirror's main with the tree fully replaced — never a rewrite,
# never `git push --force`. This keeps Docker's pinned source.commit SHAs
# resolvable forever.
#
# Idempotency (decision 2): compares `npm view <pkg> version` against the
# mirror's current package.json version; no-ops (exit 0) if already synced.
# Self-healing across dry-runs, missed CI runs, and re-runs.
#
# Usage:
#   scripts/mirror-mcp-server.sh --dry-run
#   scripts/mirror-mcp-server.sh --dry-run --source-commit <sha>
#   SOURCE_COMMIT=<sha> MIRROR_PUSH_TOKEN=<token> scripts/mirror-mcp-server.sh
#
# Env vars:
#   SOURCE_COMMIT     Monorepo commit that produced the published npm version
#                      (CI: the publish run's head_sha / $GITHUB_SHA). Falls
#                      back to `git rev-parse HEAD` only under --dry-run.
#                      May also be passed as --source-commit <sha>.
#   MIRROR_PUSH_TOKEN  Fine-grained PAT scoped to the mirror repo only, used
#                      to push. Required for a real (non---dry-run) sync;
#                      never required, read, or logged in --dry-run mode.
#
# Exit codes: 0 on success or idempotent no-op; 1 on any gate failure
# (leak audit, absolute-path check, .env* check, docker build) or usage error.

set -euo pipefail

# Never let a credential helper block on an interactive prompt in CI.
export GIT_TERMINAL_PROMPT=0

# ---------------------------------------------------------------------------
# Hardcoded surfaces — grounded against the plan + live repo state before
# writing this script (npm view, npm pack + tar -tzf, package.json, LICENSE).
# ---------------------------------------------------------------------------
readonly PACKAGE_NAME="@skillsmith/mcp-server"
readonly PACKAGE_SUBDIR="packages/mcp-server"
readonly MONOREPO_REPO_URL="https://github.com/smith-horn/skillsmith"
readonly MIRROR_REPO_SLUG="smith-horn/skillsmith-mcp-server"
readonly MIRROR_REPO_URL="https://github.com/${MIRROR_REPO_SLUG}.git"
readonly MIRROR_BRANCH="main"

# Locked, copy-paste-ready text from the plan (finding #18) — do not paraphrase.
# shellcheck disable=SC2016 # single-quoted on purpose: the backticked `packages/mcp-server` must NOT expand
readonly README_BANNER='> **This is an auto-generated, read-only mirror.** Source: [smith-horn/skillsmith](https://github.com/smith-horn/skillsmith) (`packages/mcp-server`). Do not open pull requests here — they will be closed automatically. File issues and contribute at the canonical repo instead.'

REPO_ROOT_RESOLVED="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT="$REPO_ROOT_RESOLVED"

# ---------------------------------------------------------------------------
# Globals populated during execution (declared here so functions can rely on
# them being defined, even before assignment, under `set -u`).
# ---------------------------------------------------------------------------
DRY_RUN=false
SOURCE_COMMIT="${SOURCE_COMMIT:-}"
NPM_VERSION=""
TMP_ROOT=""
TREE_DIR=""
COMMIT_SUBJECT=""
COMMIT_BODY=""
FULL_COMMIT_MESSAGE=""

# ---------------------------------------------------------------------------
# Logging — all progress goes to stderr; stdout is reserved for the
# --dry-run summary so it can be redirected/consumed cleanly.
# ---------------------------------------------------------------------------
log()  { printf '[mirror-mcp-server] %s\n' "$*" >&2; }
warn() { printf '[mirror-mcp-server] WARNING: %s\n' "$*" >&2; }
err()  { printf '[mirror-mcp-server] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: mirror-mcp-server.sh [--dry-run] [--source-commit <sha>]

Assembles the packages/mcp-server mirror tree, runs the leak-audit and
docker-build gates, and (unless --dry-run) pushes one new commit to
smith-horn/skillsmith-mcp-server.

  --dry-run              Assemble + gate + print the would-be commit; never
                          clones or pushes to the real mirror remote. Does
                          not require MIRROR_PUSH_TOKEN.
  --source-commit <sha>  Monorepo commit to archive. Overrides $SOURCE_COMMIT.
                          Falls back to `git rev-parse HEAD` only in --dry-run.
  -h, --help              Show this help.

Env: SOURCE_COMMIT, MIRROR_PUSH_TOKEN (required for a real push only).
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "required command '$1' not found on PATH"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --source-commit)
        [[ $# -ge 2 ]] || err "--source-commit requires a value"
        SOURCE_COMMIT="$2"
        shift 2
        ;;
      --source-commit=*)
        SOURCE_COMMIT="${1#*=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "unknown argument: $1 (see --help)"
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

resolve_source_commit() {
  if [[ -z "$SOURCE_COMMIT" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
      log "SOURCE_COMMIT not set — dry-run fallback to HEAD ($SOURCE_COMMIT)"
    else
      err "SOURCE_COMMIT must be set (env var or --source-commit) outside --dry-run; CI passes \$GITHUB_SHA / the triggering workflow_run's head_sha"
    fi
  fi

  git -C "$REPO_ROOT" rev-parse --verify "${SOURCE_COMMIT}^{commit}" >/dev/null 2>&1 \
    || err "SOURCE_COMMIT '$SOURCE_COMMIT' does not resolve to a commit in this checkout"

  # Normalize to a full 40-char SHA regardless of what form was passed in —
  # the Source-Commit trailer (decision 4) must be exact and unambiguous.
  SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse "$SOURCE_COMMIT")"
}

resolve_npm_version() {
  log "Resolving latest published version of ${PACKAGE_NAME} from npm..."
  NPM_VERSION="$(npm view "$PACKAGE_NAME" version 2>/dev/null || true)"
  [[ -n "$NPM_VERSION" ]] || err "npm view ${PACKAGE_NAME} version returned nothing — is it published?"
  log "Latest published version: ${NPM_VERSION}"
}

# ---------------------------------------------------------------------------
# Idempotency gate (decision 2). Exits 0 as a no-op if the mirror is already
# at NPM_VERSION. Treats "mirror repo/branch doesn't exist yet" as "not yet
# synced, proceed" — required because the mirror repo does not exist at the
# time this script is first written (Step 1 creates it, but Step 4 is the
# first real sync).
# ---------------------------------------------------------------------------
check_idempotency() {
  local ls_remote_out="$TMP_ROOT/ls-remote.txt"

  if ! git ls-remote --exit-code "$MIRROR_REPO_URL" "refs/heads/$MIRROR_BRANCH" >"$ls_remote_out" 2>/dev/null \
      || [[ ! -s "$ls_remote_out" ]]; then
    log "Mirror repo/branch not found yet (repo not created, or created but empty) — treating as first sync."
    return 0
  fi

  log "Mirror branch exists — checking currently-synced version via a shallow clone..."
  local check_dir="$TMP_ROOT/mirror-check"
  if ! git clone --quiet --depth 1 --branch "$MIRROR_BRANCH" "$MIRROR_REPO_URL" "$check_dir" 2>/dev/null; then
    warn "Could not shallow-clone ${MIRROR_REPO_SLUG} to verify its current version — proceeding with sync (self-healing by design)."
    return 0
  fi

  if [[ ! -f "$check_dir/package.json" ]]; then
    warn "Mirror has no package.json yet — proceeding with sync."
    return 0
  fi

  local mirror_version
  mirror_version="$(node -e "process.stdout.write(require('$check_dir/package.json').version || '')" 2>/dev/null || true)"

  if [[ "$mirror_version" == "$NPM_VERSION" ]]; then
    log "Mirror is already at ${PACKAGE_NAME}@${NPM_VERSION} — no-op."
    exit 0
  fi

  log "Mirror is at version '${mirror_version:-<unknown>}'; syncing to ${NPM_VERSION}."
}

# ---------------------------------------------------------------------------
# Tree assembly (decision 1)
# ---------------------------------------------------------------------------

assemble_git_archive() {
  log "Archiving ${PACKAGE_SUBDIR} at ${SOURCE_COMMIT}..."
  # packages/mcp-server/<file> has 2 path components before the file itself —
  # strip-components=2 lands every git-tracked file at the tree root
  # (verified against a real archive of this path before writing this script).
  git -C "$REPO_ROOT" archive --format=tar "$SOURCE_COMMIT" -- "$PACKAGE_SUBDIR" \
    | tar -x --strip-components=2 -C "$TREE_DIR" \
    || err "git archive of ${PACKAGE_SUBDIR} at ${SOURCE_COMMIT} failed"

  [[ -f "$TREE_DIR/Dockerfile" ]] || err "assembled tree is missing Dockerfile — git archive step produced an unexpected layout"
}

assemble_npm_dist() {
  log "Packing ${PACKAGE_NAME}@${NPM_VERSION} from npm to extract dist/..."
  local pack_dir="$TMP_ROOT/npm-pack"
  mkdir -p "$pack_dir"
  ( cd "$pack_dir" && npm pack "${PACKAGE_NAME}@${NPM_VERSION}" >/dev/null )

  local tarball
  tarball="$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
  [[ -n "$tarball" ]] || err "npm pack did not produce a .tgz for ${PACKAGE_NAME}@${NPM_VERSION}"

  # Tarball layout verified with a real `npm pack` + `tar -tzf` before writing
  # this extraction step: everything lives under a `package/` prefix, dist/
  # at `package/dist/` — strip-components=1, extract only that path.
  tar -xzf "$tarball" -C "$TREE_DIR" --strip-components=1 package/dist \
    || err "failed to extract dist/ from ${tarball##*/}"

  [[ -d "$TREE_DIR/dist" ]] || err "expected dist/ was not present in the ${PACKAGE_NAME}@${NPM_VERSION} tarball"
}

write_pr_auto_close_workflow() {
  local dest="$1"
  # Pull requests can't be disabled via mirror repo settings the way
  # issues/wiki/projects can (Step 1) — this workflow is the PR auto-responder.
  cat >"$dest" <<'YAML'
name: Close PRs (read-only mirror)

# This repo is a read-only, auto-generated mirror (see README banner).
# Pull requests can't be disabled via repo settings the way issues/wiki/
# projects can, so this workflow comments on and closes any PR opened here,
# pointing the author at the canonical repo. See SMI-5629, plan Step 1.

on:
  pull_request:
    types: [opened, reopened]

permissions:
  pull-requests: write

concurrency:
  group: pr-auto-close-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  close-pr:
    runs-on: ubuntu-latest
    steps:
      - name: Comment and close
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          gh pr comment "$PR_NUMBER" --repo "$REPO" \
            --body "This is a read-only auto-generated mirror; open PRs against smith-horn/skillsmith instead."
          gh pr close "$PR_NUMBER" --repo "$REPO"
YAML
}

add_overlays() {
  log "Adding overlay files (LICENSE, README banner, PR auto-close workflow)..."

  [[ -f "$REPO_ROOT/LICENSE" ]] || err "root LICENSE not found at ${REPO_ROOT}/LICENSE"
  cp "$REPO_ROOT/LICENSE" "$TREE_DIR/LICENSE"

  [[ -f "$TREE_DIR/README.md" ]] || err "README.md missing from assembled tree — git archive step may have failed"
  local readme_tmp="$TMP_ROOT/README.md.bannered"
  { printf '%s\n\n' "$README_BANNER"; cat "$TREE_DIR/README.md"; } > "$readme_tmp"
  mv "$readme_tmp" "$TREE_DIR/README.md"

  mkdir -p "$TREE_DIR/.github/workflows"
  write_pr_auto_close_workflow "$TREE_DIR/.github/workflows/pr-auto-close.yml"
}

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

# ---------------------------------------------------------------------------
# Version-consistency gate (fail-closed) — the git-archived source
# (SOURCE_COMMIT) and the npm-tarball dist/ (NPM_VERSION) are assembled from
# two independent sources (decision 1); nothing else guarantees they agree.
# A workflow_dispatch backfill against a not-yet-published HEAD, or a second
# publish landing mid-run, could otherwise push a mirror commit whose source
# and dist are different versions with self-contradictory Source-Commit/
# Source-Version trailers, defeating decision-4 traceability. Fail closed
# rather than push a skewed tree.
# ---------------------------------------------------------------------------
check_version_consistency() {
  [[ -f "$TREE_DIR/package.json" ]] || err "assembled tree is missing package.json — git archive step produced an unexpected layout"

  local archived_version
  archived_version="$(node -e "process.stdout.write(require('$TREE_DIR/package.json').version || '')" 2>/dev/null || true)"
  [[ -n "$archived_version" ]] || err "could not read a version from the archived package.json at ${SOURCE_COMMIT}"

  if [[ "$archived_version" != "$NPM_VERSION" ]]; then
    err "version mismatch: package.json at SOURCE_COMMIT ${SOURCE_COMMIT} is ${archived_version}, but npm's latest published version is ${NPM_VERSION} — refusing to push a mirror commit with mismatched Source-Commit/Source-Version trailers (SOURCE_COMMIT must point at the commit that published NPM_VERSION)"
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

# ---------------------------------------------------------------------------
# Commit message (decision 4)
# ---------------------------------------------------------------------------
build_commit_message() {
  COMMIT_SUBJECT="sync: ${PACKAGE_NAME}@${NPM_VERSION}"
  COMMIT_BODY="Source-Repo: ${MONOREPO_REPO_URL}
Source-Commit: ${SOURCE_COMMIT}
Source-Version: ${NPM_VERSION}"
  FULL_COMMIT_MESSAGE="${COMMIT_SUBJECT}

${COMMIT_BODY}"
}

print_dry_run_summary() {
  local file_count total_size
  file_count="$(find "$TREE_DIR" -type f | wc -l | tr -d ' ')"
  total_size="$(du -sh "$TREE_DIR" 2>/dev/null | cut -f1)"

  echo ""
  echo "=== mirror-mcp-server.sh --dry-run summary ==="
  echo "Package:        ${PACKAGE_NAME}@${NPM_VERSION}"
  echo "Source commit:  ${SOURCE_COMMIT}"
  echo "Mirror repo:    ${MIRROR_REPO_SLUG} (branch: ${MIRROR_BRANCH})"
  echo "Tree files:     ${file_count}"
  echo "Tree size:      ${total_size:-unknown}"
  echo ""
  echo "--- would-be commit message ---"
  echo "$FULL_COMMIT_MESSAGE"
  echo "--- end commit message ---"
  echo ""
  echo "Dry run only — no clone/push performed against ${MIRROR_REPO_URL}."
}

# ---------------------------------------------------------------------------
# Push (decision 3: one new commit, tree fully replaced, never --force)
# ---------------------------------------------------------------------------
push_mirror() {
  log "Cloning ${MIRROR_REPO_SLUG} for push..."
  local mirror_dir="$TMP_ROOT/mirror-push"
  local auth_header
  auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$MIRROR_PUSH_TOKEN" | base64 | tr -d '\n')"

  git -c http.extraheader="$auth_header" clone --quiet --depth 1 "$MIRROR_REPO_URL" "$mirror_dir" \
    || err "failed to clone ${MIRROR_REPO_SLUG} for push (check MIRROR_PUSH_TOKEN scope/expiry)"

  # Replace the tree wholesale — everything except .git/ is removed and
  # re-populated from the assembled candidate tree.
  find "$mirror_dir" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  cp -a "$TREE_DIR/." "$mirror_dir/"

  (
    cd "$mirror_dir"
    git checkout -B "$MIRROR_BRANCH"
    git add -A
    git -c user.name="skillsmith-mirror-bot" -c user.email="ci@skillsmith.app" \
      commit --quiet -m "$FULL_COMMIT_MESSAGE"
  )

  log "Pushing one new commit to ${MIRROR_REPO_SLUG}#${MIRROR_BRANCH} (plain push, never --force)..."
  ( cd "$mirror_dir" && git -c http.extraheader="$auth_header" push origin "HEAD:${MIRROR_BRANCH}" ) \
    || err "push to ${MIRROR_REPO_SLUG} failed"
}

# ---------------------------------------------------------------------------
main() {
  parse_args "$@"

  require_cmd git
  require_cmd npm
  require_cmd tar
  require_cmd node

  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mirror-mcp-server.XXXXXX")"
  TREE_DIR="$TMP_ROOT/tree"
  mkdir -p "$TREE_DIR"

  resolve_source_commit
  resolve_npm_version

  check_idempotency

  assemble_git_archive
  check_version_consistency
  assemble_npm_dist
  add_overlays

  run_leak_audit
  run_build_gate

  build_commit_message

  if [[ "$DRY_RUN" == "true" ]]; then
    print_dry_run_summary
    exit 0
  fi

  [[ -n "${MIRROR_PUSH_TOKEN:-}" ]] || err "MIRROR_PUSH_TOKEN is required for a real (non---dry-run) sync"

  push_mirror
  log "Sync complete: ${PACKAGE_NAME}@${NPM_VERSION} pushed to ${MIRROR_REPO_SLUG}."
}

main "$@"
