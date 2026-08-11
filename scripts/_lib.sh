#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (npm install lives in a heredoc warning string shown to users; not executed)
#
# _lib.sh — Shared utilities for worktree management scripts
#
# Sourced by: create-worktree.sh, remove-worktree.sh, rebase-worktree.sh
#
# Provides:
#   Colors:    RED, GREEN, YELLOW, BLUE, NC
#   Logging:   error(), warn(), info(), success()
#   Git:       get_main_git_dir(), is_git_crypt_encrypted()

# Guard against double-sourcing
if [[ -n "${_LIB_SH_LOADED:-}" ]]; then
    return 0
fi
_LIB_SH_LOADED=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# SMI-5650: native modules that get a writable named volume in worktree
# containers (seeded from the image's /opt/native-seed at boot). Must match
# docker-entrypoint.sh's NATIVE_MODULES array and the Dockerfile's stash list —
# keep all three in sync (a cross-file sync-check test enforces this).
#
# @esbuild IS a scope directory, not a flat module — confirmed live it is
# REQUIRED, not optional: esbuild's own top-level package (bin/esbuild, its
# JS API wrapper) does NOT contain the actual native binary esbuild spawns at
# runtime; that lives in the separate scoped platform package
# (@esbuild/<platform>-<arch>, e.g. @esbuild/linux-arm64). A bare `esbuild`
# entry alone left that scope resolving through the read-only root mount to
# main's real (possibly wrong-platform) host copy, passing tsc/type-checking
# fine but failing at actual esbuild invocation ("Syntax error: ( unexpected"
# — the shell's fallback interpretation of a non-Linux binary it can't
# execve()). Handled at the SCOPE level (mount destination
# /app/node_modules/@esbuild, not a specific platform-arch subpackage) for
# the same reason @skillsmith/@smith-horn are scope-mounted in the alias
# fix above: the image build resolves whichever platform-arch package is
# actually correct for that image, so there's nothing to hardcode.
NATIVE_MODULES_FOR_OVERLAY=("better-sqlite3" "onnxruntime-node" "esbuild" "hnswlib-node" "@esbuild")

#######################################
# Docker volume names cannot contain `@` — sanitize a NATIVE_MODULES_FOR_OVERLAY
# entry into a valid `local` volume name. Flat module names pass through
# unchanged; the sole scope entry (@esbuild) maps to a distinct, readable name
# that can't collide with the flat `esbuild` package's own volume.
#
# Arguments:
#   $1 - Entry from NATIVE_MODULES_FOR_OVERLAY (e.g. "better-sqlite3", "@esbuild")
# Outputs:
#   Sanitized volume-name-safe string to stdout
#######################################
native_module_volume_name() {
    case "$1" in
    @*) printf '%s-scope' "${1#@}" ;;
    *) printf '%s' "$1" ;;
    esac
}

#######################################
# Sanitize an arbitrary name (worktree directory basename, branch name) into
# a Docker Compose v2 project name: lowercase, then strip any character
# outside [a-z0-9_-]. This is the single canonical implementation --
# remove-worktree.sh's project_name derivation and
# prune-orphaned-docker-volumes.sh's protected-set derivation both call this
# rather than each inlining their own copy of the tr/sed pipeline, so the two
# can never independently drift out of sync (SMI-5750 governance finding:
# they previously duplicated this logic verbatim).
#
# A trailing newline is always emitted (needed by callers that invoke this
# in a loop and capture the combined output via one outer `$(...)` --
# without it, BSD sed's no-trailing-newline-preserving behavior would
# silently glue consecutive outputs together with no separator).
#
# Arguments:
#   $1 - Name to sanitize (e.g. a worktree directory basename)
# Outputs:
#   Sanitized project-name-safe string, followed by a newline, to stdout
#######################################
sanitize_project_name() {
    printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g'
}

#######################################
# Print error message and exit
#######################################
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

#######################################
# Print warning message
#######################################
warn() {
    echo -e "${YELLOW}Warning: $1${NC}" >&2
}

#######################################
# Print info message
#######################################
info() {
    echo -e "${BLUE}$1${NC}"
}

#######################################
# Print success message
#######################################
success() {
    echo -e "${GREEN}$1${NC}"
}

#######################################
# Run a command with a bounded timeout, preferring GNU `timeout` semantics
# (SMI-4700 / SMI-5596).
#
# macOS does not ship GNU `timeout`; Homebrew coreutils provides it as
# `gtimeout`. Probes `gtimeout` first, falls back to `timeout` (present
# natively on Linux, and installable on macOS), and — if neither is usable —
# runs the command UNBOUNDED. The unbounded fallback matches today's reality
# on a machine without either binary: a wedged daemon would already hang the
# caller in that case (the guard never executes), so this is no worse than
# before, not a new hazard.
#
# Extracted from repair-worktrees.sh's inline check_docker_safety_for_rebuild
# probe (SMI-4700) so create-worktree.sh's Step 8 readiness probe (SMI-5596)
# can reuse the identical capability-detection logic instead of duplicating
# it a second time.
#
# Arguments:
#   $1        - timeout in seconds
#   $2        - literal "--" separator (recommended for call-site
#               readability; skipped automatically if present)
#   $2.. / $3.. - command and its arguments to run
#
# Returns:
#   The wrapped command's own exit code. When gtimeout/timeout is available
#   and the command exceeds the bound, returns 124 (GNU timeout convention).
#   When neither binary is usable, runs the command unbounded and returns
#   its real exit code.
#######################################
run_with_timeout() {
    local seconds="$1"
    shift
    if [[ "${1:-}" == "--" ]]; then
        shift
    fi

    local timeout_bin=""
    if command -v gtimeout >/dev/null 2>&1 && gtimeout --kill-after=0 0 true >/dev/null 2>&1; then
        timeout_bin="gtimeout"
    elif command -v timeout >/dev/null 2>&1 && timeout --kill-after=0 0 true >/dev/null 2>&1; then
        timeout_bin="timeout"
    fi

    if [[ -n "$timeout_bin" ]]; then
        "$timeout_bin" "$seconds" "$@"
    else
        # Neither gtimeout nor a working timeout on PATH — run unbounded.
        "$@"
    fi
}

#######################################
# Get the actual .git directory (handles worktrees where .git is a file)
#
# Arguments:
#   $1 - Repository root path
#
# Outputs:
#   Path to the main .git directory, or empty string if not found
#######################################
get_main_git_dir() {
    local repo_root="$1"
    local git_path="$repo_root/.git"

    if [[ -f "$git_path" ]]; then
        # We're in a worktree - .git is a file pointing to the gitdir
        local worktree_gitdir
        worktree_gitdir=$(sed 's/gitdir: //' "$git_path")

        # Handle relative paths
        if [[ ! "$worktree_gitdir" = /* ]]; then
            worktree_gitdir="$repo_root/$worktree_gitdir"
        fi

        # Normalize and find the main .git directory
        # Worktree gitdirs are typically at: main_repo/.git/worktrees/<name>
        # We need to go up to main_repo/.git
        worktree_gitdir=$(cd "$worktree_gitdir" 2>/dev/null && pwd)

        # The main .git dir is the parent of "worktrees" directory
        if [[ "$worktree_gitdir" == */.git/worktrees/* ]]; then
            echo "${worktree_gitdir%/worktrees/*}"
        else
            # Fallback: try to find commondir
            if [[ -f "$worktree_gitdir/commondir" ]]; then
                local commondir
                commondir=$(cat "$worktree_gitdir/commondir")
                if [[ ! "$commondir" = /* ]]; then
                    commondir="$worktree_gitdir/$commondir"
                fi
                cd "$commondir" 2>/dev/null && pwd
            else
                echo "$worktree_gitdir"
            fi
        fi
    elif [[ -d "$git_path" ]]; then
        # Normal repository - .git is a directory
        echo "$git_path"
    else
        echo ""
    fi
}

#######################################
# Check if a file's first bytes carry git-crypt's binary magic header
# (\0GITCRYPT\0). SMI-5702: canonical consolidation of three previously
# independent copies -- this file's old xxd-based is_git_crypt_encrypted()
# (below; had a fail-open gap when xxd was unavailable, fine as an advisory
# check but unacceptable as a verification gate, plan doc finding R5),
# _rebase-git-crypt.sh's scan_ciphertext() inline `head -c 9 | tr -d '\0'`
# check, and worktree-crypt.sh's is_file_decrypted() grep form. Uses only
# head/tr (POSIX, always present on the platforms this repo supports) -- no
# xxd dependency, so there is no fail-open case left to reason about.
#
# Arguments:
#   $1 - File path to check
#
# Returns:
#   0 if the file's first 9 bytes are the git-crypt magic header, 1
#   otherwise (including a missing/unreadable file)
#######################################
has_git_crypt_magic_header() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    local head9
    head9=$(head -c 9 "$file" 2>/dev/null | LC_ALL=C tr -d '\0')
    [[ "$head9" == "GITCRYPT" ]]
}

#######################################
# Check if a file is git-crypt encrypted
#
# SMI-5702: thin wrapper over has_git_crypt_magic_header() -- kept as a
# separate name for existing callers (create-worktree.sh's
# check_git_crypt_unlocked / verify_skill_readability). No longer requires
# xxd; the prior xxd-unavailable fail-open case no longer exists.
#
# Arguments:
#   $1 - File path to check
#
# Returns:
#   0 if encrypted, 1 if not encrypted
#######################################
is_git_crypt_encrypted() {
    has_git_crypt_magic_header "$1"
}

# SMI-5702: canonical spellings git-crypt itself writes (escape_shell_arg),
# live-verified via `git config --local --get-regexp 'filter\.git-crypt'`
# -- see the plan doc's Surface Grounding table. Used both when WRITING a
# repair (unquoted form -- the tolerant CANONICAL regex below accepts either
# spelling on READ, matching what a real `git-crypt unlock` produces
# depending on git-crypt version) and when documenting the canonical values.
GIT_CRYPT_CANONICAL_SMUDGE='git-crypt smudge'
GIT_CRYPT_CANONICAL_CLEAN='git-crypt clean'
GIT_CRYPT_CANONICAL_TEXTCONV='"git-crypt" diff'

#######################################
# SMI-5702: classify the current git-crypt filter registration state.
# Primary axis (smudge, clean) -> one of 5 states; secondary axis
# (required, textconv) captured as raw values for the caller to repair
# unconditionally. Populates globals rather than returning via stdout --
# this is always called directly (never via command substitution), so
# callers see the globals immediately with no subshell-visibility gap.
#
# Tolerant CANONICAL match: /^"?git-crypt"? smudge$/ (and clean). The live
# value carries embedded double quotes (git-crypt's own escape_shell_arg);
# an exact-equality implementation would classify a HEALTHY repo as FOREIGN
# and churn config on every invocation (plan doc finding R1).
#
# Arguments:
#   $1 - git_context_dir  Any directory git can resolve (main checkout root
#        or any worktree path) -- filter.git-crypt.* config is repo-shared
#        (git-crypt's worktreeConfig=true extension is set but unused), so
#        `git -C <any-of-these>` all resolve to the same underlying
#        $GIT_COMMON_DIR/config file.
#
# Globals set:
#   GIT_CRYPT_FILTER_STATE     - CANONICAL | DISABLED | MISSING | HALF | FOREIGN
#   GIT_CRYPT_FILTER_SMUDGE    - raw filter.git-crypt.smudge value (may be empty)
#   GIT_CRYPT_FILTER_CLEAN     - raw filter.git-crypt.clean value (may be empty)
#   GIT_CRYPT_FILTER_REQUIRED  - raw filter.git-crypt.required value (may be empty)
#   GIT_CRYPT_FILTER_TEXTCONV  - raw diff.git-crypt.textconv value (may be empty)
#######################################
classify_git_crypt_filter_state() {
    local git_context_dir="$1"

    GIT_CRYPT_FILTER_SMUDGE="$(git -C "$git_context_dir" config --local --get filter.git-crypt.smudge 2>/dev/null || echo "")"
    GIT_CRYPT_FILTER_CLEAN="$(git -C "$git_context_dir" config --local --get filter.git-crypt.clean 2>/dev/null || echo "")"
    GIT_CRYPT_FILTER_REQUIRED="$(git -C "$git_context_dir" config --local --get filter.git-crypt.required 2>/dev/null || echo "")"
    GIT_CRYPT_FILTER_TEXTCONV="$(git -C "$git_context_dir" config --local --get diff.git-crypt.textconv 2>/dev/null || echo "")"

    local canon_smudge_re='^"?git-crypt"? smudge$'
    local canon_clean_re='^"?git-crypt"? clean$'

    local smudge_canon=false clean_canon=false
    [[ "$GIT_CRYPT_FILTER_SMUDGE" =~ $canon_smudge_re ]] && smudge_canon=true
    [[ "$GIT_CRYPT_FILTER_CLEAN" =~ $canon_clean_re ]] && clean_canon=true

    local smudge_absent=false clean_absent=false
    [[ -z "$GIT_CRYPT_FILTER_SMUDGE" ]] && smudge_absent=true
    [[ -z "$GIT_CRYPT_FILTER_CLEAN" ]] && clean_absent=true

    local smudge_cat=false clean_cat=false
    [[ "$GIT_CRYPT_FILTER_SMUDGE" == "cat" ]] && smudge_cat=true
    [[ "$GIT_CRYPT_FILTER_CLEAN" == "cat" ]] && clean_cat=true

    if $smudge_canon && $clean_canon; then
        GIT_CRYPT_FILTER_STATE="CANONICAL"
    elif $smudge_cat && $clean_cat; then
        GIT_CRYPT_FILTER_STATE="DISABLED"
    elif $smudge_absent && $clean_absent; then
        GIT_CRYPT_FILTER_STATE="MISSING"
    elif [[ "$smudge_absent" != "$clean_absent" ]] || [[ "$smudge_cat" != "$clean_cat" ]]; then
        # Exactly one side absent, or exactly one side "cat" (T4/T4b) --
        # asymmetric shape. Deliberately checked BEFORE the FOREIGN
        # catch-all so e.g. (canonical, cat) lands here, not FOREIGN.
        GIT_CRYPT_FILTER_STATE="HALF"
    else
        # Both present, neither pair canonical, neither pair "cat", and not
        # asymmetric -- a real (if wrong) custom filter pair.
        GIT_CRYPT_FILTER_STATE="FOREIGN"
    fi
}

#######################################
# SMI-5983: tri-state check for an in-progress `git rebase` at a given
# worktree path -- lives here (not scripts/_rebase-git-crypt.sh) because
# that file SOURCES this one, not the reverse; a function only _lib.sh's own
# callers (like the DISABLED-state heal decision below) need cannot live in
# a file _lib.sh has no dependency edge to. check_rebase_nothing_to_resolve()
# in _rebase-git-crypt.sh calls this shared predicate instead of duplicating
# the underlying git-path checks (SMI-5979 originally introduced them there).
#
# Deliberately tri-state, not boolean: a lookup failure (nonexistent path,
# inaccessible worktree, any git-path resolution error) is NOT the same as
# "confirmed no rebase in progress" -- both existing and new callers must
# treat "unknown" exactly like "active" (conservative), never like
# "inactive". A prior version of this check used `|| echo /nonexistent` as
# a fallback, which silently collapsed lookup failure into false evidence
# of inactivity -- fixed here by keeping the failure visible as its own
# state instead of paving over it.
#
# Arguments:
#   $1 - worktree_path  Any path git can resolve as a worktree
# Globals set:
#   GIT_CRYPT_REBASE_STATE  - "active" | "inactive" | "unknown"
#######################################
has_active_rebase_state() {
    local worktree_path="$1"
    local rebase_merge rebase_apply
    local rc_merge=0 rc_apply=0

    # --path-format=absolute is required, not cosmetic: the default
    # (relative) form is only meaningful when resolved relative to the -C
    # target itself, NOT the caller's actual process cwd -- and this
    # function is routinely called from a cwd that differs from
    # worktree_path (e.g. rebase-worktree.sh usually runs from the main
    # checkout while operating on a worktree path elsewhere). Confirmed via
    # direct reproduction: `[ -d "$(git -C <dir> rev-parse --git-path X)" ]`
    # silently reports false from an unrelated cwd even when the directory
    # genuinely exists.
    #
    # The `|| rc_x=$?` form (not a bare `rc=$?` after the assignment) is
    # required under `set -e` (every caller of this function runs under it,
    # e.g. _lib.sh/rebase-worktree.sh's own `set -euo pipefail`) -- a plain
    # `x="$(failing-cmd)"` assignment's own exit status IS the substituted
    # command's, so without `||` absorbing it the whole calling script would
    # exit right here, silently, before `rc_merge=$?` ever ran (found via
    # direct reproduction while investigating a create-worktree-base.test.ts
    # failure this same round -- see read_git_crypt_disabled_marker()'s
    # identical fix below for the sibling instance of this bug).
    rebase_merge="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-path rebase-merge 2>/dev/null)" || rc_merge=$?
    rebase_apply="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-path rebase-apply 2>/dev/null)" || rc_apply=$?

    if [ "$rc_merge" -ne 0 ] || [ "$rc_apply" -ne 0 ] || [ -z "$rebase_merge" ] || [ -z "$rebase_apply" ]; then
        GIT_CRYPT_REBASE_STATE="unknown"
        return 0
    fi

    if [ -d "$rebase_merge" ] || [ -d "$rebase_apply" ]; then
        GIT_CRYPT_REBASE_STATE="active"
    else
        GIT_CRYPT_REBASE_STATE="inactive"
    fi
}

#######################################
# SMI-5702: print the single canonical one-line remediation for a broken or
# intentionally-disabled git-crypt filter registration. Replaces the
# multiple config-key-removal snippets previously printed at various call
# sites (rebase-worktree.sh's conflict text, .husky/pre-commit's manual
# recovery block) -- operators/agents running those literally against the
# shared repo-wide .git/config caused two real corruption incidents
# (SMI-5702, recurrence SMI-5861).
# worktree-crypt.sh's `fix` command runs ensure_git_crypt_filter_registered()
# itself, so this is always safe to print and safe to run regardless of the
# actual underlying state (CANONICAL: no-op; DISABLED: warns and leaves it
# alone; MISSING/HALF/FOREIGN: repairs).
#
# Arguments:
#   $1 - target_path  Path to pass through to `worktree-crypt.sh fix`
#######################################
print_git_crypt_filter_remediation() {
    local target_path="$1"
    echo "  ./scripts/worktree-crypt.sh fix $target_path"
}

#######################################
# SMI-5983: dedicated lock for the git-crypt filter config read-classify-
# write sequence, replacing the semantically-mismatched
# acquire_worktree_port_lock() (built for Docker dev-container port
# allocation, SMI-5661) that ensure_git_crypt_filter_registered() previously
# reused. `mkdir`-atomic, PID recorded inside. Deliberately has NO automatic
# stale-lock reclaim (NEEDLE plan review, round 3->4: an `mv`-to-tombstone
# reclaim is atomic on the PATH, not bound to the specific lock instance a
# process inspected before deciding to reclaim, so a reclaimer can steal a
# fresh, live holder's lock created in the gap between inspection and
# reclaim -- a real ABA race with no cheap fix short of a monotonic
# generation counter, disproportionate for a lock held only milliseconds).
# Contention instead FAILS CLOSED with a manual-unstick message, mirroring
# this codebase's own StuckLockError/acquireOwnedLock pattern -- never
# proceeds unlocked against shared filter state, unlike the port lock's
# `|| true` fallback.
#
# This lock protects only the brief classify->act->write sequence at each
# call site (step_disable_filters(), restore_filter_config(),
# ensure_git_crypt_filter_registered(), pre-commit's disable+restore) --
# never the whole disabled window itself (which can span an entire rebase
# or manual conflict resolution). The marker (below) plus the two-signal
# heal check protect that longer window.
#######################################
GIT_CRYPT_FILTER_LOCK_MODE=""
GIT_CRYPT_FILTER_LOCK_DIR=""
GIT_CRYPT_FILTER_LOCK_PID_FILE=""
GIT_CRYPT_FILTER_LOCK_WAIT="${SKILLSMITH_GIT_CRYPT_FILTER_LOCK_WAIT:-10}"

#######################################
# Returns (via stdout) the bare command currently registered for the given
# trap signal, or an empty string if none is set. `trap -p SIG` prints
# `trap -- 'CMD' SIGNAME` (single-quoted, embedded single quotes escaped as
# '\''); every trap this codebase itself registers is a simple bare
# function/command name or `;`-joined sequence with no embedded quoting, so
# a straightforward strip of the `trap -- '...'` wrapper is sufficient here
# -- not a general-purpose trap-string unescaper.
#
# The trailing suffix is stripped via `'*` (shortest match from the LAST
# literal quote to end-of-string), NOT a literal `' $sig` match -- bash
# normalizes the signal name in `trap -p`'s OWN output independent of what
# was passed in (confirmed on both macOS bash 3.2 and the container's bash
# 5.2: `trap -p INT` prints `... SIGINT`, `trap -p TERM` prints
# `... SIGTERM`, but `trap -p EXIT` prints `... EXIT` with no SIG prefix --
# EXIT isn't a real signal). Matching the literal input ("INT") against the
# actual output ("SIGINT") silently failed to strip, leaving the raw
# `' SIGINT` tail glued onto the captured command -- a malformed composed
# trap body found only via direct reproduction (second-round NEEDLE review
# investigation, SMI-5983 implementation round).
#######################################
_captured_trap_cmd() {
    local sig="$1" line
    line="$(trap -p "$sig")"
    [ -z "$line" ] && return 0
    line="${line#trap -- \'}"
    line="${line%\'*}"
    printf '%s' "$line"
}

#######################################
# Acquire the git-crypt filter lock. See the block comment above.
#
# Arguments:
#   $1 - git_context_dir  Any directory git can resolve (main checkout or
#        any worktree) -- used only to find $GIT_COMMON_DIR, the lock's
#        repo-shared home (same directory the filter config itself lives
#        under, so every worktree and the main checkout contend on the
#        same physical lock regardless of which one calls this).
#
# Returns:
#   0 if acquired. 1 if the wait window expired -- a diagnostic has already
#   been printed via error() before returning (error() exits the calling
#   process; callers should treat this as unreachable-on-success only, not
#   write any handling for a returned 1 -- matching this file's existing
#   `error()`-exits convention elsewhere).
#######################################
acquire_git_crypt_filter_lock() {
    local git_context_dir="$1"
    local main_git_dir
    main_git_dir="$(get_main_git_dir "$git_context_dir")"
    if [[ -z "$main_git_dir" ]] || [[ ! -d "$main_git_dir" ]]; then
        error "git-crypt filter lock: could not resolve \$GIT_COMMON_DIR for $git_context_dir"
    fi
    GIT_CRYPT_FILTER_LOCK_DIR="$main_git_dir/skillsmith-git-crypt-filter.lock"
    GIT_CRYPT_FILTER_LOCK_PID_FILE="$GIT_CRYPT_FILTER_LOCK_DIR/pid"

    local deadline hpid
    deadline=$(( $(date +%s) + GIT_CRYPT_FILTER_LOCK_WAIT ))
    while :; do
        if mkdir "$GIT_CRYPT_FILTER_LOCK_DIR" 2>/dev/null; then
            # Written AFTER mkdir succeeds -- a crash in this exact gap
            # leaves a lock dir with no readable PID file, deliberately
            # surfaced as its own "unknown owner" diagnostic below rather
            # than silently treated as either live or reclaimable (there is
            # no reclaim path at all).
            printf '%s\n' "$$" > "$GIT_CRYPT_FILTER_LOCK_PID_FILE" 2>/dev/null || true
            # Capture whatever EXIT/INT/TERM traps the caller already had
            # BEFORE overwriting them, so release_git_crypt_filter_lock()
            # can run them too instead of silently erasing them (NEEDLE
            # review finding, SMI-5983 implementation round) -- a reusable
            # lock must never clobber unrelated cleanup a caller already
            # registered. Concretely: rebase-worktree.sh's
            # `trap restore_filter_config EXIT` is itself what fires this
            # lock (restore_filter_config() acquires it too) during a
            # crash-path restore -- overwriting that trap here used to mean
            # a crash while this lock was held would release the mutex but
            # never actually restore the git-crypt filters.
            local prev_exit_cmd prev_int_cmd prev_term_cmd
            prev_exit_cmd="$(_captured_trap_cmd EXIT)"
            prev_int_cmd="$(_captured_trap_cmd INT)"
            prev_term_cmd="$(_captured_trap_cmd TERM)"
            # Release FIRST, then the prior handler -- never the reverse:
            # the prior handler may itself call acquire_git_crypt_filter_
            # lock() again (restore_filter_config() does exactly that), and
            # this lock is not reentrant, so running it while still held
            # would deadlock/time out against ourselves.
            #
            # Double-quoted (not single-quoted): this expands
            # ${prev_*_cmd} NOW, at registration time, baking the prior
            # handler's resolved TEXT directly into the new trap body --
            # deliberately NOT a `trap '...eval "$SOME_VAR"...' SIG`
            # late-binding design (which was this fix's first draft). That
            # design re-reads a global variable at FIRE time, and since
            # repeated acquire/release cycles in the same process (e.g.
            # ensure_git_crypt_filter_registered() called in a loop over
            # several worktrees) would each overwrite that same global with
            # a string that itself references the SAME variable name, the
            # eventual eval could recurse into itself indefinitely. Baking
            # the value in now means each new trap body is fully
            # self-contained; a chain of prior handlers can only grow by
            # one bounded, idempotent `release_git_crypt_filter_lock;`
            # segment per cycle, never self-reference (NEEDLE review
            # finding, SMI-5983 implementation round -- caught during this
            # fix's own implementation, not by the review itself).
            #
            # Built conditionally (not via a fixed
            # "release...; ${prev}; exit N" template): when there is NO
            # prior handler for INT/TERM, ${prev_int_cmd}/${prev_term_cmd}
            # is empty, and a fixed template collapses to
            # `release_git_crypt_filter_lock; ; exit 130` -- a genuine bash
            # syntax error (an empty statement between two semicolons,
            # confirmed via direct reproduction: bash reports "syntax error
            # near unexpected token ';'" and the WHOLE trap body silently
            # fails to run, meaning the lock is never released and the
            # process doesn't even exit on the signal). EXIT's template
            # happened to dodge this by coincidence (nothing follows
            # ${prev_exit_cmd}, so an empty value only leaves a harmless
            # TRAILING semicolon, not a bare one sandwiched between two
            # statements) -- caught only by re-review, not by the tests
            # from this fix's first round (which covered EXIT only)
            # (second-round NEEDLE review finding, SMI-5983 implementation
            # round).
            local exit_body int_body term_body
            exit_body="release_git_crypt_filter_lock"
            [ -n "$prev_exit_cmd" ] && exit_body="${exit_body}; ${prev_exit_cmd}"
            int_body="release_git_crypt_filter_lock"
            [ -n "$prev_int_cmd" ] && int_body="${int_body}; ${prev_int_cmd}"
            int_body="${int_body}; exit 130"
            term_body="release_git_crypt_filter_lock"
            [ -n "$prev_term_cmd" ] && term_body="${term_body}; ${prev_term_cmd}"
            term_body="${term_body}; exit 143"
            trap "$exit_body" EXIT
            trap "$int_body" INT
            trap "$term_body" TERM
            GIT_CRYPT_FILTER_LOCK_MODE="held"
            return 0
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            # `|| hpid=""`, not a bare assignment: under `set -e` (every
            # caller runs under it), `cat` on the exact missing-PID-file
            # case this branch exists to diagnose would otherwise kill the
            # calling script right here, silently, before the diagnostic
            # below ever printed (same bug class as
            # read_git_crypt_disabled_marker()'s fix, found investigating a
            # test failure this same round).
            hpid="$(cat "$GIT_CRYPT_FILTER_LOCK_PID_FILE" 2>/dev/null)" || hpid=""
            if [ -z "$hpid" ]; then
                error "git-crypt filter lock busy after ${GIT_CRYPT_FILTER_LOCK_WAIT}s, holder PID unrecorded (owner unknown -- likely crashed between acquiring the lock and recording its PID). Confirm no relevant rebase-worktree.sh or git commit process is active on this machine, then run: rmdir \"$GIT_CRYPT_FILTER_LOCK_DIR\" and retry."
            elif kill -0 "$hpid" 2>/dev/null; then
                error "git-crypt filter lock busy after ${GIT_CRYPT_FILTER_LOCK_WAIT}s, held by live PID $hpid. Wait for it to finish, or investigate that process directly -- this lock never auto-reclaims a live holder."
            else
                error "git-crypt filter lock busy after ${GIT_CRYPT_FILTER_LOCK_WAIT}s, recorded holder PID $hpid is not running. Confirm via 'ps' that nothing relevant is active, then run: rmdir \"$GIT_CRYPT_FILTER_LOCK_DIR\" and retry. (This lock never auto-reclaims -- see the function's doc comment for why.)"
            fi
        fi
        sleep 0.2
    done
}

#######################################
# Release the git-crypt filter lock. Ownership-checked: only removes the
# lock directory if THIS process's PID is still the one recorded inside --
# a process must never release (or, via that release, effectively hand
# reclaim of) a lock it doesn't currently own.
#######################################
release_git_crypt_filter_lock() {
    [ "$GIT_CRYPT_FILTER_LOCK_MODE" = "held" ] || return 0
    local owner
    # `|| owner=""` -- same set -e hazard as acquire's hpid read above.
    owner="$(cat "$GIT_CRYPT_FILTER_LOCK_PID_FILE" 2>/dev/null)" || owner=""
    [ "$owner" = "$$" ] && rm -rf "$GIT_CRYPT_FILTER_LOCK_DIR" 2>/dev/null
    GIT_CRYPT_FILTER_LOCK_MODE=""
    return 0
}

#######################################
# SMI-5983: diagnostic marker for a DISABLED git-crypt filter state --
# written by both existing DISABLED-state writers (rebase-worktree.sh Step
# 7, .husky/pre-commit's branch-switch recovery) as the LAST write in their
# disable sequence (strictly after both filter.git-crypt.{smudge,clean}
# writes), cleared by both existing restore sites as the FIRST write in
# their restore sequence. This ordering is deliberate -- see the plan doc's
# §1 for the full crash-point-by-crash-point argument for why no
# transaction log is needed: every partial-write crash resolves to either
# the existing HALF-state auto-heal or the unchanged conservative
# DISABLED-without-marker decline.
#
# No ownership nonce, no captured filter values, no transaction phase --
# this marker only ever drives a heal-to-CANONICAL decision (never a
# restore-to-captured-original one), so there is nothing it needs to
# protect beyond answering "is this disable still legitimately in use".
#######################################

#######################################
# Write the DISABLED-state marker. Caller must hold the git-crypt filter
# lock. Worktree path is base64-encoded (paths can contain characters --
# colons, in principle even newlines on some filesystems -- that would
# break naive field-splitting).
#
# Arguments:
#   $1 - git_context_dir  Same directory step_disable_filters() etc. operate on
#   $2 - worktree_path    The worktree this disable belongs to (for the
#        active-rebase-state check the heal decision performs later)
#######################################
write_git_crypt_disabled_marker() {
    local git_context_dir="$1" worktree_path="$2"
    local worktree_b64
    worktree_b64="$(printf '%s' "$worktree_path" | base64 | tr -d '\n')"
    git -C "$git_context_dir" config --local skillsmith.git-crypt-disabled-marker "$$ $(date +%s) $worktree_b64"
}

#######################################
# Clear the DISABLED-state marker. Caller must hold the git-crypt filter
# lock. Safe to call even if no marker is present.
#######################################
clear_git_crypt_disabled_marker() {
    local git_context_dir="$1"
    git -C "$git_context_dir" config --local --unset skillsmith.git-crypt-disabled-marker 2>/dev/null || true
}

#######################################
# Read and parse the DISABLED-state marker. Caller must hold the git-crypt
# filter lock (or otherwise be a context where the marker can't change
# under it, e.g. tests).
#
# Any parse failure (missing key, non-numeric PID, invalid base64, empty
# decoded path, wrong field count) is reported via GIT_CRYPT_MARKER_VALID=
# false and MUST be treated identically to "marker absent" by every
# consumer -- a marker that can't be confidently parsed carries no positive
# evidence either way (SMI-5983 round-4 requirement).
#
# Arguments:
#   $1 - git_context_dir
# Globals set:
#   GIT_CRYPT_MARKER_VALID     - "true" | "false"
#   GIT_CRYPT_MARKER_PID       - only meaningful if VALID=true
#   GIT_CRYPT_MARKER_WORKTREE  - only meaningful if VALID=true (decoded)
#######################################
read_git_crypt_disabled_marker() {
    local git_context_dir="$1"
    local raw pid ts worktree_b64 worktree_path
    GIT_CRYPT_MARKER_VALID="false"
    GIT_CRYPT_MARKER_PID=""
    GIT_CRYPT_MARKER_WORKTREE=""

    raw="$(git -C "$git_context_dir" config --local --get skillsmith.git-crypt-disabled-marker 2>/dev/null || echo "")"
    [ -z "$raw" ] && return 0

    # `set --` (intentional word-splitting on IFS whitespace), not
    # awk '{print $N}', so a marker with the WRONG field count (extra
    # trailing garbage, or fewer than 3 fields) is rejected outright via
    # `$# -ne 3` -- awk's $1/$2/$3 would silently ignore any extra fields
    # and still "successfully" extract the first three, contrary to this
    # function's own "wrong field count fails closed" contract (NEEDLE
    # review finding, SMI-5983 implementation round). Safe to reassign the
    # function's positional params here: $1 (git_context_dir) was already
    # captured into a local above.
    set -- $raw
    if [ "$#" -ne 3 ]; then
        return 0
    fi
    pid="$1"
    ts="$2"
    worktree_b64="$3"
    if [ -z "$pid" ] || [ -z "$ts" ] || [ -z "$worktree_b64" ]; then
        return 0
    fi
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac
    # Timestamp must be numeric too -- previously captured but never
    # validated, so a marker with a corrupted (non-numeric) timestamp field
    # was silently accepted as valid (same review finding as above).
    case "$ts" in ''|*[!0-9]*) return 0 ;; esac
    # `|| worktree_path=""`: base64 -d exits nonzero on malformed input
    # (confirmed on both macOS and the Linux container) -- without this,
    # `set -e` would kill the calling script on exactly the malformed-marker
    # input this function exists to fail closed on, same bug class as the
    # raw-read fix above.
    worktree_path="$(printf '%s' "$worktree_b64" | base64 -d 2>/dev/null)" || worktree_path=""
    [ -z "$worktree_path" ] && return 0

    GIT_CRYPT_MARKER_VALID="true"
    GIT_CRYPT_MARKER_PID="$pid"
    GIT_CRYPT_MARKER_WORKTREE="$worktree_path"
    return 0
}

#######################################
# SMI-5702: idempotent self-heal for git-crypt filter registration. See
# docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md
# for the full root-cause writeup and design rationale -- summary: filter.
# git-crypt.{smudge,clean,required} and diff.git-crypt.textconv are
# repo-SHARED state (git-crypt's own worktreeConfig=true extension is set
# but unused -- `git config --local` always resolves to
# $GIT_COMMON_DIR/config, shared by the main checkout and every worktree).
# A classifier bug here breaks every worktree AND the main checkout at
# once -- the same failure this function exists to prevent, hence the
# defensive guarantees below.
#
# Guarantees:
#   - SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE=1 -> full no-op, checked
#     first, before the lock/classify/write sequence.
#   - Only writes filter.git-crypt.{smudge,clean} for a classified DISABLED
#     state when SMI-5983's two-signal check confirms the disable is dead
#     (marker's PID not running AND no active rebase-merge/rebase-apply
#     state at the marker's recorded worktree) -- otherwise, exactly as
#     before SMI-5983, another session's deliberate in-flight
#     filter-disable window (rebase-worktree.sh Step 7 / .husky/pre-commit's
#     branch-switch recovery) is left untouched. The secondary axis
#     (required/textconv) IS still repaired unconditionally in ALL cases
#     including a non-healing DISABLED: a missing `required` turns a loud
#     checkout failure into a silent plaintext-commit path, and
#     `required=true` alongside `cat`/`cat` is inert (`cat` always exits 0).
#   - `command -v git-crypt` gate before ANY write this call would make --
#     never points config at a nonexistent binary (same pattern as
#     scripts/pre-push-check.sh:64).
#   - Narrow lock (acquire_git_crypt_filter_lock/release_git_crypt_filter_lock,
#     SMI-5983 -- a dedicated lock, not the semantically-mismatched
#     worktree-port lock this used to reuse) around the read-classify-write
#     sequence only -- explicitly NOT around the DISABLED window itself,
#     which is bounded by another session's human-time conflict resolution;
#     a lock spanning it would deadlock every worktree operation repo-wide.
#   - Read-back verification: re-classifies after writing and hard-fails on
#     mismatch -- a silent partial write is worse than the original bug.
#
# Arguments:
#   $1 - git_context_dir  Any directory git can resolve (main checkout root
#        or any worktree path) -- see classify_git_crypt_filter_state()'s
#        doc comment for why this is safe regardless of which is passed.
#
# Returns:
#   0 - healthy (no-op, healed, disabled-by-env, or DISABLED-state warn);
#   1 - hard failure only via error() (git-crypt missing when a write is
#       needed, or read-back verification mismatch) -- error() exits the
#       calling process, matching this codebase's existing convention for
#       genuinely unrecoverable conditions (e.g. check_git_crypt_unlocked).
#######################################
ensure_git_crypt_filter_registered() {
    local git_context_dir="$1"

    if [[ "${SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE:-0}" == "1" ]]; then
        info "  git-crypt filter self-heal disabled (SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE=1)"
        return 0
    fi

    local main_git_dir
    main_git_dir="$(get_main_git_dir "$git_context_dir")"
    if [[ -z "$main_git_dir" ]] || [[ ! -d "$main_git_dir" ]]; then
        warn "  git-crypt filter self-heal: could not resolve main .git directory for $git_context_dir -- skipping"
        return 0
    fi

    # SMI-5983: dedicated lock, not the semantically-mismatched
    # acquire_worktree_port_lock() this used to reuse -- see
    # acquire_git_crypt_filter_lock()'s doc comment. Fails closed (via
    # error()) rather than proceeding unlocked.
    acquire_git_crypt_filter_lock "$git_context_dir"
    _ensure_git_crypt_filter_registered_locked "$git_context_dir"
    local rc=$?
    release_git_crypt_filter_lock
    return "$rc"
}

#######################################
# Internal: the actual read-classify-write sequence for
# ensure_git_crypt_filter_registered(), run under the caller's lock. Not
# intended to be called directly outside tests.
#######################################
_ensure_git_crypt_filter_registered_locked() {
    local git_context_dir="$1"

    classify_git_crypt_filter_state "$git_context_dir"
    local state="$GIT_CRYPT_FILTER_STATE"
    local pre_smudge="$GIT_CRYPT_FILTER_SMUDGE" pre_clean="$GIT_CRYPT_FILTER_CLEAN"
    local pre_required="$GIT_CRYPT_FILTER_REQUIRED" pre_textconv="$GIT_CRYPT_FILTER_TEXTCONV"

    # SMI-5983: for DISABLED, decide up front whether this will heal, so the
    # git-crypt-binary precondition check below covers this path too. Heals
    # only when BOTH signals agree the disable is dead: the marker's PID is
    # not running, AND that worktree has no active rebase-merge/rebase-apply
    # state (a live manual conflict deliberately makes the disabling PID
    # dead too -- step_rebase_parent() clears its own EXIT trap before
    # exiting on one -- so PID-liveness alone is not a safe signal; see the
    # plan doc's round-1 finding). A malformed or absent marker never heals.
    local disabled_will_heal=false disabled_marker_pid="" disabled_marker_worktree=""
    if [ "$state" = "DISABLED" ]; then
        read_git_crypt_disabled_marker "$git_context_dir"
        if [ "$GIT_CRYPT_MARKER_VALID" = "true" ]; then
            disabled_marker_pid="$GIT_CRYPT_MARKER_PID"
            disabled_marker_worktree="$GIT_CRYPT_MARKER_WORKTREE"
            if ! kill -0 "$disabled_marker_pid" 2>/dev/null; then
                has_active_rebase_state "$disabled_marker_worktree"
                [ "$GIT_CRYPT_REBASE_STATE" = "inactive" ] && disabled_will_heal=true
            fi
        fi
    fi

    local needs_primary_write=false
    case "$state" in
        MISSING|HALF|FOREIGN) needs_primary_write=true ;;
        DISABLED) [ "$disabled_will_heal" = true ] && needs_primary_write=true ;;
    esac
    local needs_secondary_write=false
    [[ "$pre_required" != "true" ]] && needs_secondary_write=true
    [[ -z "$pre_textconv" ]] && needs_secondary_write=true

    if { $needs_primary_write || $needs_secondary_write; } && ! command -v git-crypt >/dev/null 2>&1; then
        error "git-crypt filter registration needs repair (state: $state) but the git-crypt binary is not on PATH -- refusing to write config pointing at a nonexistent binary.

Install git-crypt (e.g. \`brew install git-crypt\` on macOS, \`apt-get install git-crypt\` on Debian/Ubuntu) and re-run."
    fi

    case "$state" in
        CANONICAL)
            : # no-op, silent
            ;;
        DISABLED)
            if [ "$disabled_will_heal" = true ]; then
                git -C "$git_context_dir" config --local filter.git-crypt.smudge "$GIT_CRYPT_CANONICAL_SMUDGE"
                git -C "$git_context_dir" config --local filter.git-crypt.clean "$GIT_CRYPT_CANONICAL_CLEAN"
                clear_git_crypt_disabled_marker "$git_context_dir"
                success "  git-crypt filters were disabled by dead PID $disabled_marker_pid (worktree: $disabled_marker_worktree, no active rebase) -- auto-healed to canonical (SMI-5983)"
            else
                warn "  git-crypt filters are deliberately disabled (smudge=clean=\"cat\") -- likely another session mid-conflict-resolution (rebase-worktree.sh Step 7 / pre-commit branch-switch recovery), or the disabling process's marker is absent/unparseable/still live/still mid-conflict. NOT healing smudge/clean."
                if [ -n "$disabled_marker_pid" ]; then
                    info "  Marker: PID $disabled_marker_pid, worktree $disabled_marker_worktree"
                fi
                print_git_crypt_filter_remediation "$git_context_dir"
            fi
            ;;
        MISSING)
            git -C "$git_context_dir" config --local filter.git-crypt.smudge "$GIT_CRYPT_CANONICAL_SMUDGE"
            git -C "$git_context_dir" config --local filter.git-crypt.clean "$GIT_CRYPT_CANONICAL_CLEAN"
            success "  git-crypt filter registration repaired (was missing)"
            ;;
        HALF)
            git -C "$git_context_dir" config --local filter.git-crypt.smudge "$GIT_CRYPT_CANONICAL_SMUDGE"
            git -C "$git_context_dir" config --local filter.git-crypt.clean "$GIT_CRYPT_CANONICAL_CLEAN"
            warn "  git-crypt filter registration was HALF-configured (smudge=\"$pre_smudge\" clean=\"$pre_clean\") -- repaired to canonical"
            ;;
        FOREIGN)
            git -C "$git_context_dir" config --local filter.git-crypt.smudge "$GIT_CRYPT_CANONICAL_SMUDGE"
            git -C "$git_context_dir" config --local filter.git-crypt.clean "$GIT_CRYPT_CANONICAL_CLEAN"
            warn "  git-crypt filter registration was FOREIGN (smudge=\"$pre_smudge\" clean=\"$pre_clean\") -- overwritten with canonical (this may have been an intentional customization -- check the values above)"
            ;;
    esac

    # Secondary axis: repaired unconditionally in ALL five states, DISABLED
    # included -- `required` absent is a silent-plaintext-commit hazard, not
    # a DX bug (see docstring above).
    if [[ "$pre_required" != "true" ]]; then
        git -C "$git_context_dir" config --local filter.git-crypt.required true
    fi
    if [[ -z "$pre_textconv" ]]; then
        git -C "$git_context_dir" config --local diff.git-crypt.textconv "$GIT_CRYPT_CANONICAL_TEXTCONV"
    fi

    # SMI-5702 test-only determinism seam for T10 (injected read-back
    # mismatch) -- inert unless the env var is set. Simulates a concurrent
    # writer clobbering our just-written value before we re-read it.
    if [[ "${SKILLSMITH_GIT_CRYPT_FILTER_FORCE_READBACK_MISMATCH_TEST:-}" == "1" ]]; then
        git -C "$git_context_dir" config --local filter.git-crypt.smudge "corrupted-by-test"
    fi

    # Read-back verification: a silent partial write is worse than the
    # original bug. Skips the primary-axis check only when we deliberately
    # did not touch smudge/clean this call (DISABLED-not-healing) -- the
    # secondary-axis checks below always run. SMI-5983: gated on
    # needs_primary_write (not a bare state != DISABLED check) since
    # DISABLED can now sometimes write too.
    classify_git_crypt_filter_state "$git_context_dir"
    if [[ "$needs_primary_write" == true ]] && [[ "$GIT_CRYPT_FILTER_STATE" != "CANONICAL" ]]; then
        error "git-crypt filter self-heal read-back verification failed: expected CANONICAL after repair, got $GIT_CRYPT_FILTER_STATE (smudge=\"$GIT_CRYPT_FILTER_SMUDGE\" clean=\"$GIT_CRYPT_FILTER_CLEAN\"). A silent partial write is worse than the original bug -- inspect .git/config directly."
    fi
    if [[ "$GIT_CRYPT_FILTER_REQUIRED" != "true" ]]; then
        error "git-crypt filter self-heal read-back verification failed: filter.git-crypt.required is \"$GIT_CRYPT_FILTER_REQUIRED\" after repair (expected \"true\")."
    fi
    if [[ -z "$GIT_CRYPT_FILTER_TEXTCONV" ]]; then
        error "git-crypt filter self-heal read-back verification failed: diff.git-crypt.textconv is empty after repair."
    fi
    return 0
}

#######################################
# SMI-5702: find a real, on-disk file matching the first git-crypt-encrypted
# glob prefix declared in <dir>/.gitattributes. De-duplicates the pattern
# previously inlined at create-worktree.sh's check_git_crypt_unlocked
# (formerly lines 97-116) and independently re-derived (differently, and
# staler) by verify_skill_readability's hardcoded .claude/skills/** scan.
#
# Arguments:
#   $1 - dir  Directory to search (repo root or worktree root)
#
# Outputs:
#   Path to a real, on-disk file under the first `filter=git-crypt`
#   .gitattributes prefix, to stdout.
# Returns:
#   0 if a file was found and printed; 1 otherwise (nothing printed) --
#   .gitattributes missing, no git-crypt filter declared, or no matching
#   file exists on disk.
#######################################
find_encrypted_test_file() {
    local dir="$1"
    local gitattributes="$dir/.gitattributes"
    [[ -f "$gitattributes" ]] || return 1

    local encrypted_pattern
    encrypted_pattern=$(grep -E 'filter=git-crypt' "$gitattributes" 2>/dev/null | head -1 | awk '{print $1}' || echo "")
    [[ -n "$encrypted_pattern" ]] || return 1

    local test_file
    test_file=$(find "$dir" -path "*/$encrypted_pattern" -type f 2>/dev/null | head -1 || echo "")
    [[ -n "$test_file" ]] || return 1

    printf '%s\n' "$test_file"
}

#######################################
# Compute relative symlink target for a worktree node_modules link (SMI-4654).
#
# Replaces hardcoded "../../node_modules" / "../../../../packages/<pkg>/..." strings.
# Depth is derived from where the symlink lives relative to repo_root, so BOTH
# layouts work:
#
#   <repo>/.worktrees/<name>/node_modules                  -> ../../node_modules
#   <repo>/<name>/node_modules                             -> ../node_modules
#   <repo>/.worktrees/<name>/packages/<pkg>/node_modules   -> ../../../../packages/<pkg>/node_modules
#   <repo>/<name>/packages/<pkg>/node_modules              -> ../../../packages/<pkg>/node_modules
#
# Caller must pass canonical absolute paths (no `..` segments). `git worktree
# list --porcelain` returns canonical paths, so production callers are safe.
#
# Arguments:
#   $1 - symlink_dir   directory that will contain the symlink (the symlink's parent)
#   $2 - target_path   absolute path the symlink should point to (under repo_root)
#   $3 - repo_root     absolute path to main repo root
#
# Outputs:
#   stdout - relative path string
# Returns:
#   0 on success; 1 (with stderr message) if symlink_dir or target_path is
#   not under repo_root. Caller is responsible for handling the failure;
#   the link/repair helpers warn-and-skip rather than aborting the batch.
#######################################
compute_relative_target() {
    local symlink_dir="$1"
    local target_path="$2"
    local repo_root="$3"

    # Normalize: strip trailing slash from repo_root.
    repo_root="${repo_root%/}"

    # Quoted-prefix strip per ShellCheck SC2295. If the strip is a no-op,
    # symlink_dir does not start with "$repo_root/" — i.e. it's not under
    # the repo. Same check for target_path.
    local rel_link_dir="${symlink_dir#"$repo_root/"}"
    if [[ "$rel_link_dir" == "$symlink_dir" ]]; then
        echo "compute_relative_target: '$symlink_dir' is not under repo root '$repo_root'" >&2
        return 1
    fi

    local rel_target="${target_path#"$repo_root/"}"
    if [[ "$rel_target" == "$target_path" ]]; then
        echo "compute_relative_target: '$target_path' is not under repo root '$repo_root'" >&2
        return 1
    fi

    # Slash count in rel_link_dir = depth - 1; ups needed = depth = slashes + 1.
    # Examples:
    #   "wt"                       -> 0 slashes -> 1 up
    #   ".worktrees/wt"            -> 1 slash   -> 2 ups
    #   "wt/packages/foo"          -> 2 slashes -> 3 ups
    #   ".worktrees/wt/packages/x" -> 3 slashes -> 4 ups
    local slashes_only="${rel_link_dir//[!\/]/}"
    local ups=$(( ${#slashes_only} + 1 ))

    local prefix="" i
    for (( i=0; i<ups; i++ )); do
        prefix+="../"
    done

    printf '%s%s\n' "$prefix" "$rel_target"
}

#######################################
# Assert host-visible node_modules resolves lint-staged (SMI-4377)
#
# Pre-commit hooks run lint-staged on host (not Docker; see SMI-2604),
# so host-visible node_modules is required. Docker named-volume installs
# (CLAUDE.md docker-first policy) populate only the container volume.
# Fails loudly per SMI-4374 retro ("silent degradation is the enemy").
#
# Arguments:
#   $1 - Repository root path
#######################################
assert_host_node_modules() {
    local repo_root="$1"
    if [[ ! -x "$repo_root/node_modules/.bin/lint-staged" ]]; then
        error "Main repo's host node_modules is missing or incomplete.

Pre-commit hooks require host-visible node_modules to resolve lint-staged,
eslint, and prettier. Docker named-volume installs (CLAUDE.md docker-first
policy) populate the container volume but not the host path.

Remediation (one-time, per clone):
  (cd $repo_root && npm install --ignore-scripts)

Then re-run this script. Host node_modules need not match the Docker
environment's native modules — it only needs the CLI binaries under
node_modules/.bin."
    fi
}

#######################################
# Reclaims a pre-existing, non-symlink node_modules directory if it is
# genuinely empty, so callers can safely replace it with the SMI-4377/4381
# symlink. Never removes non-empty content.
#
# SMI-5689: closes a gap where a stale empty directory (e.g. left behind by
# an incomplete container teardown) permanently blocked the symlink from
# ever being (re)created, breaking the host-side dependency-freshness
# sentinel, tsc --build alias resolution, and the ruflo CLI statusline.
#
# Uses rmdir (never rm -rf) so a directory that is empty right now but held
# by an active mount reference fails safely instead of silently removing
# state it shouldn't.
#
# Arguments:
#   $1 - Path to check (a node_modules directory, not a symlink)
#
# Returns:
#   0 - Reclaimed: directory was empty and rmdir succeeded. Path is now
#       absent; caller may safely ln -sfn over it.
#   1 - Preserved: directory contains real content. Left untouched.
#   2 - Empty but unremovable: rmdir failed (e.g. an active container mount
#       still references the directory). Left untouched.
#######################################
reclaim_empty_node_modules_dir() {
    local path="$1"

    if [[ -n "$(ls -A "$path" 2>/dev/null)" ]]; then
        return 1
    fi

    if rmdir "$path" 2>/dev/null; then
        return 0
    fi

    return 2
}

#######################################
# Symlink node_modules from main repo into a worktree (SMI-4377)
#
# Idempotent: refreshes an existing symlink, reclaims a pre-existing empty
# directory (SMI-5689, via reclaim_empty_node_modules_dir), skips a real
# non-empty directory, creates the symlink if missing.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Repository root path (symlink target)
#
# Returns:
#   0 on success or no-op, 1 if skipped due to unexpected state
#######################################
link_worktree_node_modules() {
    local worktree_path="$1"
    local repo_root="$2"

    # SMI-4381: relative symlink so it resolves both on host (where target is
    # /<repo>/node_modules) and inside Docker (where target is /app/node_modules).
    # An absolute host path symlink is dangling inside the container.
    # SMI-4654: depth computed dynamically; supports both `<repo>/.worktrees/<name>/`
    # (2 ups: ../../node_modules) and nested `<repo>/<name>/` (1 up: ../node_modules).
    local rel_target
    if ! rel_target="$(compute_relative_target "$worktree_path" "$repo_root/node_modules" "$repo_root")"; then
        warn "  Skipping $worktree_path: not under repo root $repo_root"
        return 1
    fi

    if [[ -L "$worktree_path/node_modules" ]]; then
        # SMI-5596: idempotent — skip the unlink+recreate when the existing
        # symlink already resolves to the correct target. A concurrent
        # sibling create-worktree.sh invocation's Step 7 sweep re-visiting an
        # already-settled worktree must be a true no-op, or it gratuitously
        # re-triggers the Docker Desktop macOS file-sharing propagation delay
        # the Step 8 readiness probe is meant to bound.
        if [[ "$(readlink "$worktree_path/node_modules")" == "$rel_target" ]]; then
            return 0
        fi
        ln -sfn "$rel_target" "$worktree_path/node_modules"
        return 0
    fi

    if [[ -e "$worktree_path/node_modules" ]]; then
        local reclaim_rc=0
        reclaim_empty_node_modules_dir "$worktree_path/node_modules" || reclaim_rc=$?
        if [[ $reclaim_rc -eq 1 ]]; then
            warn "  node_modules exists at $worktree_path and contains files — left untouched (remove manually if you believe it is stale)"
            return 1
        elif [[ $reclaim_rc -eq 2 ]]; then
            warn "  node_modules at $worktree_path/node_modules is empty but could not be removed (likely an active container mount) — run 'docker compose --profile dev down' in this worktree, then re-run"
            return 1
        fi
    fi

    # SMI-5689: belt-and-suspenders — never ln -sfn over an existing path.
    # BSD ln -sfn (macOS host) against a real, even empty, directory exits 0
    # and creates a nested <dest>/<dest-basename> symlink instead of
    # replacing it — verified live — rather than erroring, so this check
    # must run regardless of which branch above was taken.
    if [[ -e "$worktree_path/node_modules" ]]; then
        warn "  node_modules at $worktree_path/node_modules could not be reclaimed — refusing to overwrite"
        return 1
    fi

    ln -sfn "$rel_target" "$worktree_path/node_modules"
    return 0
}

#######################################
# Idempotent backfill of node_modules symlinks across all worktrees (SMI-4377)
#
# Iterates `git worktree list`, skips the main repo (real node_modules),
# creates the symlink on any worktree missing it. Reclaims a pre-existing
# empty directory (SMI-5689, via reclaim_empty_node_modules_dir); leaves a
# real non-empty directory untouched. Safe to run repeatedly.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_node_modules() {
    local repo_root="$1"
    local wt_count=0
    local repaired=0

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue

        wt_count=$((wt_count + 1))

        # SMI-4381: relative target works on host AND inside Docker bind-mount.
        # SMI-4654: depth computed dynamically; supports both `<repo>/.worktrees/<name>/`
        # (2 ups) and nested `<repo>/<name>/` (1 up).
        local rel_target
        if ! rel_target="$(compute_relative_target "$wt_path" "$repo_root/node_modules" "$repo_root")"; then
            warn "  Skipping $wt_path (not under repo root)"
            continue
        fi

        if [[ -L "$wt_path/node_modules" ]]; then
            # Refresh in case existing symlink is the absolute host-path form
            # (pre-SMI-4381) or the wrong-depth form (pre-SMI-4654).
            # SMI-5596: idempotent — skip the unlink+recreate entirely when
            # the target already matches, so a redundant sweep across
            # concurrent sibling worktree creations is a true no-op and
            # cannot reopen an already-settled worktree's propagation window.
            if [[ "$(readlink "$wt_path/node_modules")" != "$rel_target" ]]; then
                ln -sfn "$rel_target" "$wt_path/node_modules"
            fi
            continue
        fi
        if [[ -d "$wt_path/node_modules" ]]; then
            local reclaim_rc=0
            reclaim_empty_node_modules_dir "$wt_path/node_modules" || reclaim_rc=$?
            if [[ $reclaim_rc -eq 1 ]]; then
                continue
            elif [[ $reclaim_rc -eq 2 ]]; then
                warn "  node_modules at $wt_path/node_modules is empty but could not be removed (likely an active container mount) — run 'docker compose --profile dev down' in this worktree, then re-run"
                continue
            fi
        fi

        # SMI-5689: belt-and-suspenders — never ln -sfn over an existing
        # path (see link_worktree_node_modules for the BSD ln -sfn nesting
        # hazard this guards against).
        if [[ -e "$wt_path/node_modules" ]]; then
            warn "  node_modules at $wt_path/node_modules could not be reclaimed — refusing to overwrite"
            continue
        fi

        ln -sfn "$rel_target" "$wt_path/node_modules"
        info "  Repaired: $wt_path"
        repaired=$((repaired + 1))
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    if [[ $repaired -gt 0 ]]; then
        success "  Repaired $repaired of $wt_count worktree(s)"
    elif [[ $wt_count -gt 0 ]]; then
        success "  All $wt_count worktree(s) already have node_modules"
    fi
}

#######################################
# Symlink per-package node_modules from main repo into a worktree (SMI-4381).
#
# Why: workspace-pinned deps live under packages/<pkg>/node_modules in the
# main repo. Without per-package symlinks, Node module resolution from the
# worktree's package walks up to the hoisted root node_modules, which can
# carry a DIFFERENT version (e.g. zod@4.x at root vs zod@3.25.76 in
# packages/mcp-server). The wrong version surfaces as type errors when
# pre-commit Phase 2 (typecheck) runs from the worktree.
#
# Idempotent: refreshes an existing symlink, skips a real directory.
# Iterates packages/* discovered in the main repo.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Repository root path (symlink target base)
#######################################
link_worktree_package_node_modules() {
    local worktree_path="$1"
    local repo_root="$2"
    local pkg_dir pkg_name

    [[ ! -d "$repo_root/packages" ]] && return 0

    # SMI-4381: relative symlink resolves on host AND inside Docker.
    # SMI-4654: depth computed dynamically; supports both layouts.
    #   e.g. `.worktrees/<name>/packages/<pkg>` → 4 ups (../../../../packages/<pkg>/node_modules)
    #        nested  `<name>/packages/<pkg>`    → 3 ups (../../../packages/<pkg>/node_modules)
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        # Canonical (no trailing/double slashes) for the symlink-target string.
        local main_target="$repo_root/packages/$pkg_name/node_modules"
        local link_parent="$worktree_path/packages/$pkg_name"
        local link="$link_parent/node_modules"

        # Target must exist in main repo for the symlink to be useful.
        [[ -d "$main_target" ]] || continue
        # Worktree may not have this package directory (e.g. branch predates it).
        [[ -d "$link_parent" ]] || continue

        local rel_target
        if ! rel_target="$(compute_relative_target "$link_parent" "$main_target" "$repo_root")"; then
            warn "  Skipping per-package link for $link_parent (not under repo root)"
            continue
        fi

        if [[ -L "$link" ]]; then
            # SMI-5596: idempotent — see link_worktree_node_modules above for
            # the rationale (skip unlink+recreate when already correct).
            if [[ "$(readlink "$link")" != "$rel_target" ]]; then
                ln -sfn "$rel_target" "$link"
            fi
            continue
        fi
        if [[ -e "$link" ]]; then
            # Real dir at worktree — leave it; user's responsibility.
            continue
        fi
        ln -sfn "$rel_target" "$link"
    done
}

#######################################
# Idempotent backfill of per-package node_modules across all worktrees (SMI-4381).
#
# Companion to repair_worktrees_node_modules. Iterates `git worktree list`,
# skips the main repo, applies link_worktree_package_node_modules to each.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_package_node_modules() {
    local repo_root="$1"
    local wt_count=0

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue

        wt_count=$((wt_count + 1))
        link_worktree_package_node_modules "$wt_path" "$repo_root"
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    if [[ $wt_count -gt 0 ]]; then
        success "  Per-package node_modules synced across $wt_count worktree(s)"
    fi
}

#######################################
# Enumerate compose bind mounts for the worktree override (SMI-4689 / SMI-5560).
#
# Emits PER-PACKAGE node_modules bind mounts, one line per packages/<pkg>/
# whose node_modules dir exists in the main repo:
#
#   <host>/packages/<pkg>/node_modules:/app/packages/<pkg>/node_modules:ro
#
# These give the worktree container access to the main checkout's
# workspace-pinned (non-hoisted) per-package deps + prebuilt native modules,
# which virtiofs cannot serve via the dangling SMI-4381 relative symlinks on
# macOS Docker Desktop.
#
# The `:ro` flag is load-bearing (SMI-5560). Without it, any worktree process
# that writes inside a per-package node_modules — most commonly a `npm install`
# reifying a native module (`rename better-sqlite3 -> .better-sqlite3-<rand>`) —
# writes straight THROUGH the bind mount into the MAIN checkout's real files
# (confirmed leak: a stale `.better-sqlite3-*` temp left in main's
# packages/core/node_modules dated 2026-07-04). Read-only turns that silent
# cross-checkout corruption into a loud EROFS. Each mount is a SINGLE mount of
# a UNIQUE host directory, which on virtiofs marks only its own path read-only
# and does NOT propagate the read-only "host_mark" to unrelated base-mount
# paths — verified end-to-end in the SMI-5560 investigation (core/src,
# website/public and /app all stay writable). The propagation regression seen
# earlier came specifically from a same-host-dir DOUBLE mount (see below), not
# from `:ro` per se.
#
# WORKSPACE-SIBLING whole-package mounts (previously
# <host>/packages/<pkg>:/app/node_modules/<scoped-name>) were REMOVED in
# SMI-5560. Two reasons:
#   1. Corruption/shadowing. The image's `npm ci` seeds a workspace symlink
#      (@scope/<pkg> -> ../../packages/<pkg>) into the per-worktree node_modules
#      volume. Docker resolved the whole-package mount's DESTINATION through
#      that symlink and landed the MAIN checkout's package dir at
#      /app/packages/<pkg>, SHADOWING the worktree's own source: worktree edits
#      became invisible to the container and worktree builds wrote dist/ into
#      main. Dropping the mount un-shadows the worktree; the seeded symlink now
#      resolves the alias to the worktree's OWN /app/packages/<pkg> (its own
#      freshly-built dist, not main's stale copy — strictly more correct).
#   2. virtiofs double-mount. The per-package node_modules mount above is a
#      SUBDIRECTORY of the whole-package mount, so the same host dir
#      (packages/<pkg>/node_modules) was bind-mounted at two container paths.
#      That same-host-dir double-mount is exactly what made a `:ro` retrofit
#      trip the virtiofs host_mark propagation regression. Removing the
#      whole-package mount removes the double-mount, making the `:ro` above safe.
#
# Companion: the worktree's per-package node_modules symlink resolves to
# /packages/<pkg>/node_modules (OUTSIDE /app) inside the container, so Node's
# hoist walk-up needs a /node_modules -> /app/node_modules bridge to reach the
# hoisted root deps (matters for esbuild bundling, e.g. vscode). That bridge
# is NOT actively created by any script — it is an emergent effect of the
# same mount(2) symlink-clamping mechanism documented above: the bind
# destination /app/node_modules is itself a symlink on the worktree host
# side, so the kernel redirects the real mount to land at /node_modules
# (container root) instead. docker-entrypoint.sh's worktree-gated call into
# repair-worktree-container-symlinks.sh is a CONSUMER of this location
# (SMI-5570/SMI-5074), not its creator (SMI-5626 plan-review correction,
# 2026-07-09 — the prior comment wrongly attributed the bridge to
# entrypoint-created code that does not exist).
#
# Output is intended to be appended under a `volumes:` block; caller handles
# indentation context. Each emitted line uses 6-space indent.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
enumerate_compose_node_modules_mounts() {
    local repo_root="$1"
    local pkg_dir pkg_name main_target

    [[ ! -d "$repo_root/packages" ]] && return 0

    # SMI-5626: ROOT node_modules bind mount, READ-ONLY. The base compose file
    # mounts a named volume at /app/node_modules; in a worktree project that
    # volume is useless — the worktree's host-side relative symlink
    # (node_modules -> ../../node_modules, sized for HOST nesting depth, SMI-4377) sits
    # under the .:/app bind, and mount(2) follows symlinks when resolving a
    # bind destination (SMI-5570/SMI-5074), so root-hoisted deps (e.g. marked,
    # sanitize-html) are unreachable in the container even though the host tree
    # is correct. Mount the MAIN checkout's real root tree instead, same
    # pattern as the per-package mounts below. Compose merges service `volumes`
    # entries by container target path, so this entry REPLACES the base file's
    # named-volume entry for worktree projects (verify via `docker compose
    # config`). `:ro` is load-bearing twice over: (1) same SMI-5560 rationale —
    # a worktree npm install must not write through into main's real tree; and
    # (2) docker-entrypoint.sh's repair-worktree-container-symlinks.sh mutates
    # hoisted @skillsmith/* alias symlinks under the resolved root — against a
    # writable bind of main's REAL host tree that would corrupt main's own
    # workspace aliases; :ro turns it into that script's existing non-fatal
    # warning path (it always exits 0).
    if [[ -d "$repo_root/node_modules" ]]; then
        printf '      - %s:/app/node_modules:ro\n' "$repo_root/node_modules"
        # Writable cache overlays, mirroring the per-package .vite/.vite-temp
        # pattern below (root-level vitest/vite runs write these under the
        # ROOT node_modules; both exist in main's tree today). Same
        # nested-subdirectory shape already proven safe against the virtiofs
        # host_mark propagation regression.
        local root_cache_dir
        for root_cache_dir in .vite .vite-temp; do
            printf '      - %s/%s:/app/node_modules/%s\n' \
                "$repo_root/node_modules" "$root_cache_dir" "$root_cache_dir"
        done
    fi

    # SMI-5650: writable tmpfs overlays over the read-only root mount, for the
    # workspace-alias SCOPE directories AND the four native-module dirs.
    #
    # (1) ALIAS SCOPES. Main's node_modules/@skillsmith + @smith-horn contain ONLY npm-workspaces
    # alias symlinks whose relative targets (../../packages/<pkg>) clamp to
    # /packages/<pkg> (empty scaffolding) inside the container's shallower
    # nesting — the SMI-5570/SMI-5074 mount(2) mechanism, this time observed at
    # require()-resolution time rather than mount time (SMI-5650). A tmpfs at the
    # SCOPE level shadows those broken links with an empty writable dir that
    # docker-entrypoint.sh's repair-worktree-container-symlinks.sh repopulates at
    # every boot with links to the worktree's OWN /app/packages/<pkg>. The
    # destination's final path component is a REAL DIRECTORY on the host (guarded
    # below), never a symlink — this is what prevents reproducing the leaf-symlink
    # escape that crashed a prior per-alias mount attempt ("too many levels of
    # symlinks", plan §1.4). Same child-inside-read-only-parent shape as the
    # .vite/.vite-temp overlays above.
    #
    # (2) NATIVE MODULE DIRS. better-sqlite3/onnxruntime-node/esbuild/hnswlib-node,
    # plus the @esbuild SCOPE (esbuild's JS API spawns its actual native binary
    # from the separate @esbuild/<platform>-<arch> package, not from anything
    # inside the flat `esbuild` package itself — confirmed live, see
    # native_module_volume_name's comment), need a writable target for the
    # SMI-5351 self-heal rebuild loop in docker-entrypoint.sh, which the :ro
    # root mount broke (SMI-5650). A NAMED VOLUME (not tmpfs — see below) +
    # boot-time seed from the image's /opt/native-seed (built during the
    # image's own Linux npm rebuild) fixes this deterministically and offline.
    # Applied to all five entries uniformly — which flat modules are single-
    # vs multi-platform in a given host checkout is incidental npm-rebuild
    # history, not a stable invariant to special-case on.
    #
    # NAMED VOLUME, NOT tmpfs (this is the key difference from the alias
    # scopes above): Compose's `type: tmpfs` volume hardcodes `noexec` with no
    # override field on the `tmpfs:` sub-object — confirmed live this breaks
    # native module loading (blocks execve() for esbuild's spawned CLI binary,
    # AND blocks dlopen()'s mmap(PROT_EXEC) for some — not all — shared
    # objects, e.g. onnxruntime-node/hnswlib-node but not better-sqlite3). A
    # bare `driver: local` NAMED volume (no driver_opts, no tmpfs annotation
    # at all) sidesteps this entirely — it's the SAME ordinary volume
    # mechanism the base docker-compose.yml already uses for the main
    # checkout's own node_modules (never noexec, native modules load fine
    # there today), not a hardening-default override. Declarations are
    # emitted once by enumerate_native_module_volumes(), referenced here by
    # name via native_module_volume_name() (Docker volume names can't contain
    # `@`, so the @esbuild entry is sanitized to a distinct "esbuild-scope"
    # name). Tradeoff vs tmpfs: disk-backed and persistent across container
    # restarts rather than RAM-backed and self-clearing — see
    # native_module_volume_name's neighboring comment block for why this is
    # safe (docker-entrypoint.sh's VALIDATION_FAILED path already detects and
    # re-seeds a corrupted persisted binary via a real invocation check, not
    # a bare require()).
    #
    # MOUNT ORDER IS LOAD-BEARING (SMI-5650 plan-review M1): the alias-scope
    # loop below MUST stay textually AFTER the root `:ro` mount block above
    # (native-module volume references have no such ordering dependency —
    # they're independent named volumes, not destinations resolved through
    # the root mount's own symlink-clamping). Compose applies a service's
    # `volumes:` entries in list order, and the alias scope-directory tmpfs
    # destinations only resolve correctly (plan §1.4) once the root mount has
    # already landed and exposed @skillsmith/@smith-horn as real directories
    # to mount over. Reordering those two blocks silently reintroduces the
    # crash risk; a generated-YAML line-order test asserts the root mount
    # precedes each alias tmpfs target so a future reorder fails CI instead.
    #
    # The 2 alias scopes and the 5 native-module entries are emitted by TWO
    # SEPARATE loops below (not a single mixed list) because their mount
    # shapes now differ: alias scopes are inline `type: tmpfs` (1MiB, no
    # size distinction needed — see above for why), native-module entries are
    # named-volume references (no size field at the reference site; sizing
    # doesn't apply to a plain `driver: local` volume the way it did to tmpfs).
    # NATIVE MODULES use a plain Docker-managed named volume (NOT the type:
    # tmpfs shorthand used for the alias scopes below): Docker Compose's
    # tmpfs volume type hardcodes noexec (confirmed live: `mount | grep`
    # shows `noexec` with no override field exposed on the `tmpfs:`
    # sub-object). noexec blocks execve() outright (broke esbuild's spawned
    # CLI binary, "Permission denied") AND — contrary to the initial
    # assumption that dlopen()'s mmap(PROT_EXEC) path is unaffected —
    # confirmed live to also block dlopen() for some shared objects
    # (onnxruntime-node and hnswlib-node both failed ERR_DLOPEN_FAILED
    # "failed to map segment from shared object"; only better-sqlite3
    # happened to tolerate it, an artifact of its own binary's internal
    # structure, not something to special-case on).
    #
    # A bare `driver: local` named volume with NO tmpfs annotation sidesteps
    # this cleanly: it is a completely standard Docker-managed volume, the
    # SAME mechanism the base docker-compose.yml already uses for the main
    # checkout's own `node_modules` (which has never had noexec and loads
    # native modules fine today) — this isn't disabling a hardening default,
    # it's using the ordinary volume type that was never restricted, rather
    # than the tmpfs type's own hardcoded default. Tradeoff vs. tmpfs:
    # disk-backed (Docker's storage driver) and persistent across container
    # restarts rather than RAM-backed and self-clearing — a corrupted binary
    # is no longer wiped by a plain restart, but docker-entrypoint.sh's
    # existing native-module VALIDATION_FAILED path already detects a broken
    # binary via require() and unconditionally re-seeds on that path, so
    # correctness is unaffected, only which of the two already-implemented
    # code paths performs the fix. Volume declarations are emitted once by
    # enumerate_native_module_volumes(), referenced here by name.
    #
    # SMI-5650 follow-up filed to reconsider tmpfs+explicit-exec (discarded
    # here in favor of shipping the lower-risk fix first) if the persistence
    # tradeoff ever proves to matter in practice.
    local overlay_dir
    for overlay_dir in @skillsmith @smith-horn; do
        # Real-directory guard: the leaf must exist AND must NOT be a symlink (a
        # symlink leaf would escape via mount(2) — see the notes above and plan
        # §1.4). Missing (fresh clone, pre-install) or unexpectedly-a-symlink →
        # skip: fail toward today's known breakage, never toward a
        # container-create failure. noexec (Compose's tmpfs default) is fine
        # here — these scopes hold only symlinks, never executable content.
        if [[ -d "$repo_root/node_modules/$overlay_dir" && ! -L "$repo_root/node_modules/$overlay_dir" ]]; then
            printf '      - type: tmpfs\n'
            printf '        target: /app/node_modules/%s\n' "$overlay_dir"
            printf '        tmpfs:\n'
            printf '          size: 1048576\n'
        fi
    done
    local native_module
    for native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
        if [[ -d "$repo_root/node_modules/$native_module" && ! -L "$repo_root/node_modules/$native_module" ]]; then
            printf '      - native-seed-%s:/app/node_modules/%s\n' \
                "$(native_module_volume_name "$native_module")" "$native_module"
        fi
    done

    # Per-package node_modules mounts, READ-ONLY (SMI-5560). Same gate as
    # link_worktree_package_node_modules:358.
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        main_target="$repo_root/packages/$pkg_name/node_modules"
        [[ -d "$main_target" ]] || continue
        printf '      - %s:/app/packages/%s/node_modules:ro\n' "$main_target" "$pkg_name"

        # SMI-5560 follow-up: vite/vitest write their own dependency
        # pre-bundle cache (.vite/) and config-bundling temp files
        # (.vite-temp/) directly inside node_modules — confirmed via a live
        # repro: `cd packages/<pkg> && vitest run` (the exact invocation
        # scripts/pre-push-coverage-check.sh uses per-package) failed with
        # EROFS writing node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs
        # once node_modules went read-only above. Both dirs are gitignored
        # (covered by the blanket `node_modules` rule) — layering a writable
        # overlay here is the same nested-subdirectory pattern already proven
        # safe against the virtiofs host_mark propagation regression (a
        # SUBDIRECTORY mount under this package's own single node_modules
        # mount, not a second mount of an overlapping-but-distinct host path
        # — the double-mount shape that caused that regression no longer
        # exists at all now that the workspace-sibling mount is gone).
        local build_cache_dir
        for build_cache_dir in .vite .vite-temp .astro; do
            printf '      - %s/%s:/app/packages/%s/node_modules/%s\n' \
                "$main_target" "$build_cache_dir" "$pkg_name" "$build_cache_dir"
        done

        # SMI-5784: PER-PACKAGE native-module writable overlays, same shape
        # as the root-level native-module loop above (named volume, NOT
        # tmpfs — see that loop's comment for the noexec rationale) but
        # targeting a workspace-local, non-hoisted copy under THIS package's
        # own node_modules (e.g. packages/core/node_modules/better-sqlite3,
        # pinned independently of root per SMI-4484). Declared once by
        # enumerate_native_module_volumes()'s matching per-package pass,
        # referenced here by the same native-seed-<pkg>-<sanitized-module>
        # name. Positioned immediately after the .vite/.vite-temp/.astro
        # sub-loop above as an authoring CONVENTION (matches how every other
        # per-package override line in this file is ordered) — Compose
        # merges a service's `volumes:` entries by target path, not list
        # position, so this ordering is not load-bearing the way the root
        # `:ro` mount preceding the alias-scope tmpfs targets is (see that
        # loop's own mount-order comment); verified against a real
        # container-create test, not just this line-order convention.
        local pkg_native_module
        for pkg_native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
            if [[ -d "$main_target/$pkg_native_module" && ! -L "$main_target/$pkg_native_module" ]]; then
                printf '      - native-seed-%s-%s:/app/packages/%s/node_modules/%s\n' \
                    "$pkg_name" "$(native_module_volume_name "$pkg_native_module")" "$pkg_name" "$pkg_native_module"
            fi
        done
    done
}

#######################################
# Ensure the host-side source directories for the writable cache overlays
# (`.vite`/`.vite-temp`/`.astro`) exist BEFORE a container that mounts them
# is created (SMI-5705). A Docker bind mount's source is resolved at
# container-CREATE time; if the source directory doesn't exist yet, the
# resulting mount can end up non-writable in a way only a full recreate
# (`--force-recreate`), not a plain `restart`, fixes. `enumerate_compose_node_modules_mounts`
# emits the mount lines unconditionally on the subdirectories existing —
# this function is what actually creates them.
#
# Root level stays `.vite`/`.vite-temp` only (matches the root loop's own
# scope in enumerate_compose_node_modules_mounts — no `.astro` there, since
# Astro never runs at the repo root). Per-package level gets all three,
# matching the per-package loop above (SMI-5722 extended this to `.astro`).
#
# Kept as a separate function from enumerate_compose_node_modules_mounts —
# that function is a pure-output helper (generate_docker_override_to_stdout's
# docstring), and repair_worktrees_compose_override's diff-based idempotency
# check relies on it being side-effect-free when comparing generated YAML.
#
# `mkdir -p` on an already-existing (or concurrently-being-created)
# directory is EEXIST-tolerant in both GNU coreutils and BSD/macOS — safe to
# call from concurrent sibling-worktree sessions with no lock needed.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
ensure_build_cache_mount_sources() {
    local repo_root="$1"
    local pkg_dir pkg_name main_target

    [[ -d "$repo_root/node_modules" ]] && mkdir -p "$repo_root/node_modules/.vite" "$repo_root/node_modules/.vite-temp"
    for pkg_dir in "$repo_root"/packages/*/; do
        pkg_name="$(basename "$pkg_dir")"
        main_target="$repo_root/packages/$pkg_name/node_modules"
        [[ -d "$main_target" ]] && mkdir -p "$main_target/.vite" "$main_target/.vite-temp" "$main_target/.astro"
    done
}

#######################################
# Emit the top-level `volumes:` section declaring the exec-capable named
# volumes native modules mount into (SMI-5650). Called ONCE per generated
# override (not per-service, unlike enumerate_compose_node_modules_mounts's
# per-service volume-list lines) — Compose merges top-level `volumes:` keys
# by name, so this is additive alongside the base compose file's own
# `node_modules:` named volume, not a replacement.
#
# Bare `driver: local`, no driver_opts: an ordinary Docker-managed volume,
# same mechanism as the base compose file's own `node_modules:` volume — see
# the emission-loop comment above in enumerate_compose_node_modules_mounts
# for why this (not tmpfs) is the fix for the noexec dlopen()/execve()
# failures discovered live.
#
# Emission is gated identically to the per-service native-module mount lines
# above (same real-directory guard) so a volume is never declared with no
# service referencing it.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
enumerate_native_module_volumes() {
    local repo_root="$1"
    local native_module
    local pkg_dir pkg_name

    for native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
        if [[ -d "$repo_root/node_modules/$native_module" && ! -L "$repo_root/node_modules/$native_module" ]]; then
            printf '  native-seed-%s:\n' "$(native_module_volume_name "$native_module")"
            printf '    driver: local\n'
            # SMI-5750: positive ownership marker so
            # prune-orphaned-docker-volumes.sh can identify these as
            # Skillsmith-owned and auto-reclaim orphaned ones (worktree
            # removed without going through remove-worktree.sh) instead of
            # leaving them perpetually UNCONFIRMED. Same label/rationale as
            # docker-compose.yml's node_modules volume.
            printf '    labels:\n'
            printf '      app.skillsmith.owned: "true"\n'
        fi
    done

    # SMI-5784: second, PER-PACKAGE pass. Workspace-local, non-hoisted copies
    # (e.g. packages/core/node_modules/better-sqlite3, pinned independently
    # per SMI-4484 — a structural, permanent divergence from root, not
    # incidental drift; see docs/internal/implementation/
    # smi-5784-native-seed-per-package-volumes.md's Context) need their OWN
    # writable overlay, distinct from the root-only volumes declared above.
    # Same real-directory guard (not a symlink). Naming is
    # native-seed-<pkg>-<sanitized-module> — the extra -<pkg>- segment makes
    # collision with a root-only name or another package's volume for the
    # SAME module impossible (each package is its own guarded loop
    # iteration); package directory names (core, doc-retrieval-mcp,
    # mcp-server, cli, …) are already lowercase-with-hyphens and
    # Docker-volume-name-safe, so only the module segment needs
    # native_module_volume_name()'s @-sanitization.
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        for native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
            if [[ -d "$pkg_dir/node_modules/$native_module" && ! -L "$pkg_dir/node_modules/$native_module" ]]; then
                printf '  native-seed-%s-%s:\n' "$pkg_name" "$(native_module_volume_name "$native_module")"
                printf '    driver: local\n'
                printf '    labels:\n'
                printf '      app.skillsmith.owned: "true"\n'
            fi
        done
    done
}

#######################################
# Worktree port-bucket collision resolution (SMI-5661).
#
# Problem: generate_docker_override_to_stdout previously derived a worktree's
# port bucket (1-99, mapped to host ports 3000+offset*10 .. +3) purely from a
# `cksum` hash of the worktree name. Two independent worktree names can hash
# to the SAME bucket (verified live: "smi-5641-remove-dead-dep-helpers" and
# "smi-5651-registry-catchup" both hash to bucket 79), and a bucket can also
# collide with a port some OTHER process already has bound on the host (e.g.
# a lingering container, or an unrelated dev server). Either collision made
# `docker compose up` fail with a host-level EADDRINUSE for one of the two
# worktrees, with no retry or reassignment.
#
# Fix: probe candidate buckets in order (deterministic hash first, so the
# common case is unchanged), skipping any bucket whose 4 ports collide with
# a SIBLING worktree's override file or with a port already LISTENing on the
# host, wrapping around the full 1-99 space before giving up.
#######################################

#######################################
# Parse the HOST-side ports out of a generated docker-compose.override.yml.
#
# Override port lines have the fixed shape (quoted "HOST:CONTAINER"):
#   - "37910:3000"   # Main app
#
# Arguments:
#   $1 - Path to a docker-compose.override.yml (may not exist)
# Outputs:
#   stdout - one host port per line; empty if the file is absent or has none
#######################################
_parse_override_host_ports() {
    local file="$1"
    [ -f "$file" ] || return 0
    grep -oE '"[0-9]+:[0-9]+"' "$file" 2>/dev/null | tr -d '"' | cut -d: -f1
}

#######################################
# Read back the host port a worktree's OWN docker-compose.override.yml
# already publishes for the `dev` service's container port 3001 (SMI-4298).
#
# Why this exists: Docker Compose CONCATENATES `ports:` lists across `-f`
# files rather than replacing them, so the base docker-compose.yml's
# `'${DEV_PORT:-3001}:3001'` (docker-compose.yml:23) survives into every
# worktree's merged config ALONGSIDE that worktree's own bucketed
# `<base+1>:3001` entry from generate_docker_override_to_stdout. Every
# worktree therefore also silently claims host port 3001 and collides with
# the main checkout's skillsmith-dev-1 (verified live via `docker compose
# --profile dev config`: 3 published entries without DEV_PORT, 2 with it).
# `.env` is a symlink shared by the main checkout and every worktree
# (create-worktree.sh:427), so DEV_PORT can never be set per-worktree
# there -- it has to be exported by whatever invokes `docker compose up`.
#
# READS BACK the already-assigned value rather than recomputing the bucket
# via _resolve_worktree_port_offset: that resolver is deliberately stateful
# (sticky start-offset, sibling scan, host-bound probe), so a second
# independent computation can disagree with what the override already
# wrote. The override file is what actually provisioned the running
# container -- the same ground-truth argument worktree-docker.sh's
# resolve_container_name makes for container_name.
#
# Parsing: scoped to the `dev:` service block, because DEV_PORT governs the
# `dev` service's 3001 publish specifically and the `test` service must
# never supply it. The generator emits service keys at exactly 2-space
# indent and their bodies at 4+, so `/^  dev:/,/^  [a-z]/` bounds the block
# (sed evaluates the end pattern from the line AFTER the start, so `  dev:`
# cannot close its own range). The grep/tr/cut chain is the same shape
# _parse_override_host_ports already uses, narrowed to `:3001`.
#
# Arguments:
#   $1 - Path to a docker-compose.override.yml (may not exist)
# Outputs:
#   stdout - the host port (e.g. 3891) when the dev block has a ":3001" map
# Returns:
#   0 on success; 1 if the file is absent or its dev block has no ":3001"
#######################################
resolve_worktree_dev_port() {
    local file="$1"
    local port
    [ -f "$file" ] || return 1
    port="$(sed -n '/^  dev:/,/^  [a-z]/p' "$file" 2>/dev/null \
                | grep -oE '"[0-9]+:3001"' \
                | head -1 | tr -d '"' | cut -d: -f1)"
    [ -n "$port" ] || return 1
    printf '%s\n' "$port"
}

#######################################
# Export DEV_PORT for a worktree's `docker compose` invocation (SMI-4298).
#
# Sets DEV_PORT to the SAME host port the worktree's own override already
# maps to container port 3001, so Compose's config resolution dedupes the
# two now-identical `<port>:3001` entries into exactly one instead of
# publishing an extra 3001. Verified live: with DEV_PORT unset the merged
# config has 3 published entries (one of them the colliding 3001); with it
# set to the override's own value, exactly 2, no stray 3001, no error.
#
# No override file at all (main checkout -- repair_worktrees_compose_override
# skips repo_root at _lib.sh:1492 and the file is gitignored there; or a
# worktree predating SMI-4377): SILENT no-op. There is no per-worktree port
# assignment to honor and the base `:-3001` default is correct.
#
# Override present but with no dev-block ":3001" (hand-edited, or an old
# format): print a one-line NOTE and fall through to the same default. That
# is exactly today's behavior for every worktree -- degrading to the status
# quo is not a regression, and hard-failing here would break `up` outright.
#
# Deliberately OVERWRITES a caller-supplied DEV_PORT: the override is ground
# truth for what this compose project publishes, and a stale hand-set value
# is precisely the drift recorded in
# docs/internal/retros/2026-05-19-smi-5001-gh-866-882-historical-triage.md
# ("DEV_PORT=3013 was ignored"). The printed line names the source so the
# change is never silent. Typing `DEV_PORT=x docker compose up` by hand
# still works -- it bypasses these scripts entirely.
#
# Uses `printf` rather than warn(): callers such as worktree-docker.sh
# deliberately redefine warn() AFTER sourcing this file (see its header
# comment at worktree-docker.sh:21-30), so warn()'s destination would
# otherwise be caller-dependent. The two messages deliberately use
# DIFFERENT streams (plan-review Critical #1): the success-path
# confirmation goes to stderr, matching the neighboring SMI-5661 helpers'
# style; the fallback NOTE goes to stdout, because it is the one message
# that must survive `docker-health.sh`'s `pretest: "... 2>/dev/null || true"`
# wiring (package.json:14) -- a stderr-only NOTE would be silently
# swallowed on exactly the call site most likely to run unattended.
#
# Arguments:
#   $1 - Absolute path to the worktree (NOT to the override file)
# Returns:
#   Always 0 -- every call site runs under `set -e` and the fallback is a
#   documented degradation, not an error.
#######################################
export_worktree_dev_port() {
    local worktree_path="$1"
    local override="$worktree_path/docker-compose.override.yml"
    local port

    [ -f "$override" ] || return 0

    if port="$(resolve_worktree_dev_port "$override")"; then
        export DEV_PORT="$port"
        printf 'DEV_PORT=%s (read back from %s -- SMI-4298)\n' "$port" "$override" >&2
    else
        # Plan-review fix (Critical #1): this NOTE — unlike the success-path
        # confirmation above — goes to STDOUT, not stderr. docker-health.sh
        # is wired into `npm test` as `pretest: "bash scripts/docker-health.sh
        # 2>/dev/null || true"` (package.json:14), which discards stderr
        # entirely. A stderr-only NOTE would be silently swallowed on
        # exactly the call site most likely to run unattended, reproducing
        # -- invisibly -- the exact collision this plan exists to fix.
        printf 'NOTE: %s has no dev-service ":3001" port mapping -- leaving DEV_PORT unset, so this compose project ALSO publishes host port 3001 and can collide with the main checkout container. Regenerate it: ./scripts/worktree-docker.sh generate %s (SMI-4298)\n' \
            "$override" "$worktree_path"
    fi
    return 0
}

#######################################
# True if $1 is the MAIN checkout; false for a linked worktree (SMI-5836).
#
# A linked worktree's `--git-dir` is main's `.git/worktrees/<name>` while its
# `--git-common-dir` is main's `.git`, so the two differ; in the main checkout
# both resolve to the same path (`.git`, relative, with cwd at the root).
# Verified live: main -> `.git`/`.git`; worktree -> `<root>/.git/worktrees/wt`
# and `<root>/.git`.
#
# The `-n "$gcd"` test is load-bearing: on a NON-git path both rev-parse calls
# fail and both vars are empty, which would otherwise compare equal and report
# a non-git directory as the main checkout.
#
# Extracted from worktree-docker.sh's resolve_container_name so that script
# holds exactly ONE copy of the test (SMI-5626 precedent: two copies of one
# derivation drifted apart). Lives here, not locally, because _lib.sh already
# owns every other worktree derivation helper -- and because the same idiom is
# independently reimplemented in six OTHER places (hook-docker-detect.sh:137,
# check-dist-fresh.sh:71, check-node-modules-fresh.sh:124, .husky/post-merge:26,
# regen-lockfile.sh:75, dependabot-regenerate-lockfile.sh:94), two of them
# POSIX `sh` hooks that cannot source this file. Consolidating those is a
# separate refactor; this at least gives it a destination.
#
# Arguments:
#   $1 - Path to a checkout or worktree
# Returns:
#   0 if $1 is the main checkout; 1 otherwise (including non-git paths)
#######################################
is_main_checkout() {
    local path="$1" gcd gd
    gcd=$(git -C "$path" rev-parse --git-common-dir 2>/dev/null)
    gd=$(git -C "$path" rev-parse --git-dir 2>/dev/null)
    [[ -n "$gcd" && "$gcd" == "$gd" ]]
}

#######################################
# Refuse a worktree-only subcommand pointed at the MAIN checkout (SMI-5836).
#
# `start` and `generate` both WRITE a worktree-shaped
# docker-compose.override.yml for whatever path they are given (cmd_start
# auto-generates one when missing, worktree-docker.sh:184-189). Applied to
# the main checkout that file overrides the base compose file's
# `container_name: skillsmith-dev-1` (docker-compose.yml:14) with
# `main-dev-1` (_lib.sh:1507), moves the documented 3001 publish to a
# bucketed pair (3070/3071 for branch `main`), and on macOS bind-mounts
# main's own node_modules READ-ONLY over /app/node_modules (_lib.sh:703-704),
# replacing the base named volume at docker-compose.yml:26 -- so
# `docker exec skillsmith-dev-1 npm install` afterwards fails EROFS against
# a container that no longer exists under that name. Nothing undoes it: the
# file is gitignored (.gitignore:190) and repair_worktrees_compose_override
# skips the repo root (_lib.sh:1611).
#
# Hard error rather than degrading to a base-file-only `up`: `start .` from
# main is a location mistake (docker-guide.md:137 documents that exact form
# "from inside the worktree"), so quietly starting MAIN's container would
# report success while the container the user actually wanted never came up --
# the invisible-success class SMI-5559/SMI-5570 already fixed twice for
# `docker exec`. Neither subcommand has any programmatic caller in the repo
# (hook-docker-detect.sh:157 uses `resolve`), so this cannot break CI, hooks
# or npm scripts. Full rationale:
# docs/internal/implementation/smi-5836-worktree-docker-start-main-guard.md
#
# Lives here alongside is_main_checkout, not in worktree-docker.sh (SMI-5836
# plan-review Critical #2): that script has only ~12 lines of headroom under
# the 500-line check-file-length.mjs hard limit and is not grandfathered in
# check-file-length.ignore, while _lib.sh already is (SMI-5660). Calls
# error(), defined identically here (_lib.sh:92-95) and in worktree-docker.sh
# (:83-86); which copy actually runs is inert since both are functionally
# identical.
#
# Arguments:
#   $1 - Subcommand name, for the message
#   $2 - Path to check (no-op unless it is the main checkout)
#######################################
refuse_if_main_checkout() {
    local subcommand="$1" path="$2" stray=""

    is_main_checkout "$path" || return 0

    if [[ -f "$path/docker-compose.override.yml" ]]; then
        stray="

Also, a stray override already exists here:
  rm $path/docker-compose.override.yml
Nothing regenerates or removes it automatically, so it keeps overriding this
checkout's container name, ports and node_modules mount until you delete it."
    fi

    error "'$subcommand' is for linked worktrees, but $path is the MAIN checkout (SMI-5836).

The base docker-compose.yml already provisions the main checkout completely:
container skillsmith-dev-1 on host port 3001. A worktree override here renames
that container, moves its ports, and (on macOS) remounts its node_modules
read-only.

If you meant the main checkout:
  cd $path && docker compose --profile dev up -d

If you meant a worktree ('$subcommand .' only works from INSIDE one):
  $(basename "$0") $subcommand .worktrees/<name>
  ./scripts/create-worktree.sh <branch>   # if it does not exist yet$stray"
}

#######################################
# Enumerate host ports already claimed by SIBLING worktrees' override files,
# excluding the main repo and the worktree being resolved itself (half of the
# self-collision-avoidance fix — see _resolve_worktree_port_offset for the
# other half).
#
# Arguments:
#   $1 - repo_root    Main repository root (for `git worktree list`)
#   $2 - self_path    Worktree path currently being resolved (excluded)
# Outputs:
#   stdout - one host port per line, across all other worktrees
#######################################
_worktree_sibling_taken_ports() {
    local repo_root="$1" self_path="$2" wt
    while IFS= read -r wt; do
        [ -z "$wt" ] && continue
        [ "$wt" = "$repo_root" ] && continue
        [ "$wt" = "$self_path" ] && continue
        _parse_override_host_ports "$wt/docker-compose.override.yml"
    done < <(git -C "$repo_root" worktree list --porcelain 2>/dev/null \
                 | sed -n 's/^worktree //p')
}

#######################################
# Check whether a port is already bound (LISTENing) on the host.
#
# `lsof -nP -iTCP:<port> -sTCP:LISTEN` reads the kernel socket table for
# LISTEN-state sockets, ships on both macOS and Linux, and generates no
# network traffic. `nc -z` opens a real connection (flaky, and flag syntax
# diverges between BSD and GNU `nc`); `ss` is Linux-only; `netstat` is
# deprecated on macOS. Known limitation: this only sees sockets owned by
# processes the current user can enumerate — Docker's own EADDRINUSE at
# `up` time remains the final backstop.
#
# Arguments:
#   $1 - port number to check
# Returns:
#   0 if bound (or check skipped/unavailable — fails toward "assume bound"
#     only when a real check ran and found a LISTENer); 1 if free or lsof
#     is unavailable / the check is disabled.
#######################################
_worktree_host_port_bound() {
    local port="$1"
    [ "${SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK:-}" = "1" ] && return 1
    command -v lsof >/dev/null 2>&1 || return 1
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

#######################################
# Resolve a collision-free port bucket (1-99) for a worktree.
#
# Two mechanisms cooperate to avoid a worktree reprobing itself away from its
# OWN currently-assigned bucket (self-collision avoidance):
#   1. _worktree_sibling_taken_ports (above) excludes self_path from the
#      sibling scan.
#   2. This function's "sticky" start-offset: if the worktree already has an
#      override file, the probe STARTS from the bucket already recorded
#      there (recovered from its own host ports) rather than from the
#      deterministic hash, and treats the worktree's OWN 4 ports as never a
#      collision. Without this, repair_worktrees_compose_override
#      regenerating a worktree whose container is live on a probed
#      (non-deterministic) bucket would reprobe it back toward the
#      deterministic hash and desync the override from the running
#      container.
#
# Loop invariant: `offset=$(( (offset % 99) + 1 ))` cycles through the full
# 1..99 space exactly once before repeating — no infinite loop, no silent
# reuse; after 99 failed attempts this returns failure instead.
#
# Arguments:
#   $1 - worktree_path   Absolute path to the worktree being resolved
#   $2 - worktree_name   Sanitized worktree name (input to the cksum hash)
#   $3 - repo_root       Main repository root
# Outputs:
#   stdout - the resolved offset (1-99) on success
#   stderr - a NOTE when reassigned away from the deterministic hash, or an
#            ERROR when no free bucket was found
# Returns:
#   0 on success, 1 if no free bucket was found after a full cycle
#######################################
_resolve_worktree_port_offset() {
    local worktree_path="$1" worktree_name="$2" repo_root="$3"

    local deterministic_offset
    deterministic_offset=$(printf '%s' "$worktree_name" | cksum | awk '{print ($1 % 99) + 1}')

    local own_ports start_offset own_base cand
    own_ports="$(_parse_override_host_ports "$worktree_path/docker-compose.override.yml" | tr '\n' ' ')"
    start_offset="$deterministic_offset"
    if [ -n "${own_ports// /}" ]; then
        own_base=$(printf '%s\n' $own_ports | sort -n | head -1)
        if [ -n "$own_base" ] && [ $(( (own_base - 3000) % 10 )) -eq 0 ]; then
            cand=$(( (own_base - 3000) / 10 ))
            [ "$cand" -ge 1 ] && [ "$cand" -le 99 ] && start_offset="$cand"
        fi
    fi

    local sibling_ports
    sibling_ports="$(_worktree_sibling_taken_ports "$repo_root" "$worktree_path" | tr '\n' ' ')"

    [ -n "${SKILLSMITH_WORKTREE_PORT_TEST_DELAY:-}" ] && sleep "$SKILLSMITH_WORKTREE_PORT_TEST_DELAY"

    local offset="$start_offset" attempt=0 p base free
    while [ "$attempt" -lt 99 ]; do
        base=$(( 3000 + offset * 10 ))
        free=1
        for p in "$base" $((base+1)) $((base+2)) $((base+3)); do
            case " $own_ports " in *" $p "*) continue ;; esac
            case " $sibling_ports " in *" $p "*) free=0; break ;; esac
            if _worktree_host_port_bound "$p"; then free=0; break; fi
        done
        if [ "$free" -eq 1 ]; then
            if [ "$offset" != "$deterministic_offset" ]; then
                printf 'NOTE: worktree port bucket %s (deterministic) unavailable — reassigned to bucket %s (SMI-5661)\n' \
                    "$deterministic_offset" "$offset" >&2
            fi
            printf '%s\n' "$offset"
            return 0
        fi
        offset=$(( (offset % 99) + 1 ))
        attempt=$(( attempt + 1 ))
    done

    printf 'ERROR: no free worktree port bucket found after 99 attempts — free up host ports or remove stale worktrees (SMI-5661)\n' >&2
    return 1
}

#######################################
# Concurrency lock guarding worktree port-bucket resolution + override write
# (SMI-5661). Adapted from retrieval-autoheal.sh's acquire_lock/release_lock
# (scripts/retrieval-autoheal.sh:108-198): flock when available (fd 8, held
# for the caller's life — the kernel releases it on any exit including a
# crash), else a non-evicting atomic `mkdir` lock for stock macOS bash 3.2
# (no `flock`, no `exec {var}>` fd auto-allocation, so the fd is hardcoded).
#
# One lock per MAIN-REPO checkout (key = `cksum` of repo_root, so all
# worktrees of the same repo — which all read/write each other's override
# files — serialize against each other; different repos never contend).
# Test-isolated via SKILLSMITH_WORKTREE_PORT_LOCK_HOME (mirrors
# SKILLSMITH_AUTOHEAL_HOME in retrieval-autoheal.sh).
#
# Best-effort: on timeout (busy flock, or a live mkdir-lock holder), WARN and
# return non-zero; the caller proceeds UNLOCKED rather than refusing to
# create/repair a worktree over lock contention — Docker's own EADDRINUSE at
# `up` time is the final backstop, same as the host-port-bound check above.
#######################################
WORKTREE_PORT_LOCK_MODE=""
WORKTREE_PORT_LOCK_DIR=""
WORKTREE_PORT_LOCK_PID_FILE=""
_WORKTREE_PORT_LOCK_FD=8
WORKTREE_PORT_LOCK_WAIT="${SKILLSMITH_WORKTREE_PORT_LOCK_WAIT:-10}"
WORKTREE_PORT_LOCK_TMAX="${SKILLSMITH_WORKTREE_PORT_LOCK_TMAX:-60}"

#######################################
# Acquire the worktree port-bucket lock. See the block comment above.
#
# Arguments:
#   $1 - repo_root   Main repository root (used to derive the lock key)
# Returns:
#   0 if the lock was acquired (or locking is disabled); 1 if acquisition
#   timed out (caller proceeds unlocked; a warning has already been printed)
#######################################
acquire_worktree_port_lock() {
    local repo_root="$1"
    [ "${SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE:-}" = "1" ] && { WORKTREE_PORT_LOCK_MODE="disabled"; return 0; }

    local home key state_dir flock_file
    home="${SKILLSMITH_WORKTREE_PORT_LOCK_HOME:-$HOME}"
    key="$(printf '%s' "$repo_root" | cksum | awk '{print $1}')"
    state_dir="$home/.skillsmith"
    mkdir -p "$state_dir" 2>/dev/null || true
    WORKTREE_PORT_LOCK_DIR="$state_dir/worktree-ports-$key.lock"
    WORKTREE_PORT_LOCK_PID_FILE="$WORKTREE_PORT_LOCK_DIR/pid"
    flock_file="$state_dir/worktree-ports-$key.flock"

    local force_mkdir=""
    [ "${SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK:-}" = "1" ] && force_mkdir="1"

    if [ -z "$force_mkdir" ] && command -v flock >/dev/null 2>&1; then
        if eval "exec ${_WORKTREE_PORT_LOCK_FD}>\"$flock_file\""; then
            if flock -w "$WORKTREE_PORT_LOCK_WAIT" "$_WORKTREE_PORT_LOCK_FD"; then
                WORKTREE_PORT_LOCK_MODE="flock"
                return 0
            fi
            eval "exec ${_WORKTREE_PORT_LOCK_FD}>&-" 2>/dev/null || true
            warn "  Worktree port lock busy after ${WORKTREE_PORT_LOCK_WAIT}s — proceeding best-effort (SMI-5661)"
            return 1
        fi
    fi

    local deadline hpid hstart age
    deadline=$(( $(date +%s) + WORKTREE_PORT_LOCK_WAIT ))
    while :; do
        if mkdir "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null; then
            printf '%s %s\n' "$$" "$(date +%s)" > "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null || true
            if [ "$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)" != "$$" ]; then
                continue
            fi
            trap 'release_worktree_port_lock' EXIT
            trap 'release_worktree_port_lock; exit 130' INT
            trap 'release_worktree_port_lock; exit 143' TERM
            WORKTREE_PORT_LOCK_MODE="mkdir"
            return 0
        fi
        hpid="$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
        hstart="$(awk '{print $2}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
        if [ -n "$hpid" ] && ! kill -0 "$hpid" 2>/dev/null; then
            rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true; continue
        fi
        age=0; [ -n "$hstart" ] && age=$(( $(date +%s) - hstart ))
        if [ "$age" -gt "$WORKTREE_PORT_LOCK_TMAX" ]; then
            rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true; continue
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            warn "  Worktree port lock held by live pid ${hpid:-?} after ${WORKTREE_PORT_LOCK_WAIT}s — proceeding best-effort (SMI-5661)"
            return 1
        fi
        sleep 0.2
    done
}

#######################################
# Release the worktree port-bucket lock acquired by acquire_worktree_port_lock.
# Ownership-checked in mkdir mode: only removes the lock dir if THIS process
# still owns it (a stale/reclaimed lock's original holder must not delete a
# reclaimer's live lock).
#######################################
release_worktree_port_lock() {
    case "$WORKTREE_PORT_LOCK_MODE" in
        flock)
            eval "exec ${_WORKTREE_PORT_LOCK_FD}>&-" 2>/dev/null || true
            ;;
        mkdir)
            local owner
            owner="$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
            [ "$owner" = "$$" ] && rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true
            ;;
    esac
    WORKTREE_PORT_LOCK_MODE=""
}

#######################################
# Emit worktree docker-compose.override.yml content to stdout (SMI-4738 split).
#
# Pure-output form of generate_docker_override: produces the same YAML body
# the wrapper would write to disk, but to stdout. Lets callers diff generated
# content against an existing override (content-compare idempotency, replacing
# the static marker grep) before deciding whether to overwrite.
#
# Note on `Generated:` timestamp: the body embeds `$(date -u …)`. The wrapper
# `repair_worktrees_compose_override` strips this single header line before
# `cmp -s` so back-to-back regens of semantically-identical content count as
# byte-equal. If the line stayed in the diff window, every postinstall run
# would rewrite every override even with no drift.
#
# Idempotency marker: the `# SMI-4689 bind mounts v2` comment line still ships
# in output as a human-readable label, but is no longer the idempotency
# primitive (replaced by content-compare in repair_worktrees_compose_override).
#
# Arguments:
#   $1 - Worktree path (used only for `# Worktree:` header / never written to)
#   $2 - Branch name
#   $3 - Repository root path (for resolving per-package node_modules; main repo)
#######################################
generate_docker_override_to_stdout() {
    local worktree_path="$1"
    local branch_name="$2"
    local repo_root="$3"

    # Extract a short name from branch (e.g., feature/jwt-rollout -> jwt-rollout)
    local worktree_name
    worktree_name=$(basename "$branch_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

    # Resolve a collision-free port bucket (SMI-5661). Deterministic cksum hash is
    # the first candidate (common case unchanged); probes the next bucket on a
    # sibling-override or host-bound collision; sticky to this worktree's own
    # existing override so a live container is not reprobed away from its ports.
    # CALLER holds acquire_worktree_port_lock across this + the override write.
    local port_offset
    if ! port_offset="$(_resolve_worktree_port_offset "$worktree_path" "$worktree_name" "$repo_root")"; then
        return 1
    fi

    # Base ports: dev=3001, test=3002. Port +3 in this bucket is intentionally
    # left unused (not reassigned) since removing the now-deleted orchestrator
    # service (SMI-5719) — the collision-check loop in
    # _resolve_worktree_port_offset still reserves 4 consecutive ports per
    # bucket, which stays harmless (merely slightly conservative) rather than
    # renumbering every existing worktree's deterministic port assignment.
    local dev_app_port=$((3000 + port_offset * 10))
    local dev_mcp_port=$((3000 + port_offset * 10 + 1))
    local test_port=$((3000 + port_offset * 10 + 2))

    # SMI-4689: per-package bind mounts only on macOS Docker Desktop.
    local volumes_block=""
    local volumes_marker=""
    if [[ "$(uname)" == "Darwin" ]]; then
        local mounts
        mounts="$(enumerate_compose_node_modules_mounts "$repo_root")"
        if [[ -n "$mounts" ]]; then
            volumes_marker="    volumes:
      # SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5 (root + per-package node_modules read-only + alias-scope tmpfs overlays):
      # the ROOT node_modules and each package's node_modules are bind-mounted
      # READ-ONLY from the main repo so workspace-pinned + prebuilt-native +
      # root-hoisted deps resolve inside the container (replaces the SMI-4381
      # relative symlinks virtiofs cannot traverse; the root mount replaces the
      # base compose named volume, SMI-5626). The :ro flag stops a worktree npm
      # install from writing through the mount into main's real checkout
      # (SMI-5560). The former workspace-sibling whole-package mounts were
      # removed: they shadowed the worktree's own source with main's and created
      # the same-host-dir double-mount that made :ro trip the virtiofs host_mark
      # regression. Alias resolution now flows through npm's own seeded workspace
      # symlink to the worktree's OWN /app/packages/<pkg>. SMI-5650 additionally
      # layers small writable tmpfs overlays at the @skillsmith/@smith-horn scope
      # dirs on top of the :ro root mount so the entrypoint can (re)create those
      # workspace aliases pointing at the worktree's own packages. See
      # enumerate_compose_node_modules_mounts for the root/per-package mounts and
      # the mount(2) symlink-clamping notes there.
"
            volumes_block="${volumes_marker}${mounts}"
        fi
    fi

    # SMI-5650: top-level named-volume declarations for the exec-capable
    # native-module tmpfs volumes referenced by name in ${volumes_block}
    # above. Emitted ONCE (not per-service) — see
    # enumerate_native_module_volumes for why this can't be the same
    # `type: tmpfs` inline shape the alias scopes use.
    local top_level_volumes=""
    if [[ "$(uname)" == "Darwin" ]]; then
        local native_volumes
        native_volumes="$(enumerate_native_module_volumes "$repo_root")"
        if [[ -n "$native_volumes" ]]; then
            top_level_volumes="
volumes:
${native_volumes}"
        fi
    fi

    cat << EOF
# Worktree-specific overrides (auto-generated by create-worktree.sh / repair-worktrees.sh)
# Container names and ports must be unique per worktree
# Worktree: $branch_name
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Platform: $(uname)

services:
  dev:
    container_name: ${worktree_name}-dev-1
    ports:
      - "${dev_app_port}:3000"   # Main app
      - "${dev_mcp_port}:3001"   # MCP server
${volumes_block}
  test:
    container_name: ${worktree_name}-test-1
    ports:
      - "${test_port}:3000"      # Test app
${volumes_block}
${top_level_volumes}
EOF
}

#######################################
# Generate worktree docker-compose.override.yml (SMI-4377/SMI-4381/SMI-4689).
#
# Thin wrapper around generate_docker_override_to_stdout that writes the body
# to <worktree_path>/docker-compose.override.yml. Preserves the existing API
# used by create-worktree.sh and repair-worktrees.sh callers.
#
# SMI-5661: the port-bucket resolution + write are guarded by the worktree
# port-bucket lock so two concurrent create-worktree.sh invocations can't both
# read the same "free" bucket before either has written its override (a
# TOCTOU race the resolver's own probe cannot close by itself). Best-effort —
# see acquire_worktree_port_lock's own doc comment for the unlocked fallback.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Branch name (used for unique container names + port hash)
#   $3 - Repository root path (for resolving per-package node_modules; main repo)
# Returns:
#   0 on success; 1 if generate_docker_override_to_stdout failed (e.g. no
#   free port bucket found)
#######################################
generate_docker_override() {
    local worktree_path="$1"
    local branch_name="$2"
    local repo_root="$3"
    local rc=0

    acquire_worktree_port_lock "$repo_root" || true
    generate_docker_override_to_stdout "$worktree_path" "$branch_name" "$repo_root" \
        > "$worktree_path/docker-compose.override.yml" || rc=$?
    release_worktree_port_lock

    return $rc
}

#######################################
# Idempotent regen of docker-compose.override.yml across all in-tree worktrees
# on macOS (SMI-4689 / SMI-4738). On Linux, no-op (bind mounts not needed).
#
# Companion to repair_worktrees_node_modules / repair_worktrees_package_node_modules.
# Iterates `git worktree list`, skips the main repo, off-tree worktrees, and
# worktrees missing docker-compose.yml.
#
# Idempotency primitive (SMI-4738 / plan-review C1+H1): generates the new
# override body to a temp file via generate_docker_override_to_stdout, then
# `diff` against the existing override with the `Generated:` timestamp line
# excluded. If the meaningful content matches, skip the move and count as
# `skipped`; otherwise atomically `mv` the temp into place. This replaces
# the previous static `# SMI-4689 bind mounts v2` marker check, which could
# not detect drift caused by adding a new package — the marker stayed
# present even though the bind-mount list was stale.
#
# The `Generated:` line is excluded from the comparison via `grep -v` so
# postinstall (which runs frequently) doesn't rewrite every override on
# every `npm install` purely due to timestamp drift.
#
# Branch name is recovered from the worktree's HEAD (`git -C $wt branch --show-current`)
# so the regenerated override is byte-equivalent to a fresh create-worktree run.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_compose_override() {
    local repo_root="$1"
    local wt_path branch_name override tmp modified=0 skipped=0

    if [[ "$(uname)" != "Darwin" ]]; then
        info "  macOS-only — skipping per-package bind-mount regen on $(uname)"
        return 0
    fi

    # SMI-5705: re-ensure the writable cache-overlay source directories exist
    # on every regen pass, not just at initial worktree creation — vite/Astro
    # can delete/recreate .vite-temp/.astro during normal operation, and every
    # npm install (which triggers this via postinstall) is exactly the kind
    # of event that can coincide with that.
    ensure_build_cache_mount_sources "$repo_root"

    # SMI-5661: acquire the port-bucket lock ONCE for the whole regen pass
    # (not per-iteration) since the loop below calls
    # generate_docker_override_to_stdout directly — not through the
    # generate_docker_override wrapper — so there is no nested acquire and
    # thus no self-deadlock risk. Released once after the loop, before the
    # summary. Best-effort: acquire_worktree_port_lock warns and returns
    # non-zero on contention; the regen proceeds unlocked rather than
    # skipping worktrees outright.
    acquire_worktree_port_lock "$repo_root" || true

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue
        # Off-tree worktree gate (SMI-4689 plan-review): if no compose.yml
        # in the worktree, no override is consumable. Skip silently.
        [[ -f "$wt_path/docker-compose.yml" ]] || continue

        branch_name="$(git -C "$wt_path" branch --show-current 2>/dev/null)"
        if [[ -z "$branch_name" ]]; then
            warn "  Could not determine branch for $wt_path; skipping"
            continue
        fi

        override="$wt_path/docker-compose.override.yml"
        # Generate to temp file in the worktree dir so the final `mv` is
        # atomic (same filesystem). On any error, clean up the temp.
        tmp="$(mktemp "$wt_path/.docker-compose.override.yml.XXXXXX")" || {
            warn "  Could not create temp file in $wt_path; skipping"
            continue
        }

        if ! generate_docker_override_to_stdout "$wt_path" "$branch_name" "$repo_root" > "$tmp"; then
            warn "  Failed to generate override body for $wt_path; skipping"
            rm -f "$tmp"
            continue
        fi

        # Compare with the volatile `Generated:` timestamp line excluded so
        # postinstall doesn't rewrite every override on every `npm install`
        # purely due to timestamp drift. `diff -q` returns 0 on match, 1 on
        # differ; both are non-fatal here.
        if [[ -f "$override" ]] \
            && diff -q \
                <(grep -v '^# Generated: ' "$tmp") \
                <(grep -v '^# Generated: ' "$override") \
                >/dev/null 2>&1; then
            rm -f "$tmp"
            skipped=$((skipped + 1))
            continue
        fi

        mv "$tmp" "$override"
        modified=$((modified + 1))
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    release_worktree_port_lock

    if [[ $modified -gt 0 ]]; then
        success "  Regenerated docker-compose.override.yml for $modified worktree(s) (SMI-4689)"
    fi
    if [[ $skipped -gt 0 ]]; then
        info "  Skipped $skipped worktree(s) — override content already current"
    fi
}

#######################################
# Enumerate submodule paths declared in a repo's .gitmodules (SMI-4829).
#
# Replaces hardcoded "docs/internal" references in worktree tooling. With only
# docs/internal declared (current pre-cutover state) this returns a single
# line; post-cutover (Wave 3 adds the strategy submodule mounts) it returns N.
#
# Arguments:
#   $1 - repo_root   absolute path to the repo whose .gitmodules to read
#
# Outputs:
#   stdout - one submodule path per line (in declaration order); empty if
#            .gitmodules is absent or has no submodule.<name>.path entries
# Returns:
#   0 always (missing .gitmodules is not an error — pre-cutover state)
#######################################
enumerate_submodules() {
    local repo_root="$1"
    local gitmodules="$repo_root/.gitmodules"
    if [[ ! -f "$gitmodules" ]]; then
        return 0
    fi
    # `git config --get-regexp` lines look like:
    #   submodule.docs/internal.path docs/internal
    # The trailing field is the path. awk extracts column 2; if a path ever
    # contains whitespace (rare but legal), git stores it quoted/escaped and
    # this helper would need updating — flag at that time.
    #
    # SMI-4829 footgun: `git config --file <abs-path>` STILL performs repo
    # discovery from cwd to evaluate `[includeIf "gitdir:..."]` directives,
    # and a stale `.git` file (e.g. a worktree imported from another host
    # whose gitdir pointer is now invalid) makes git exit 128 — silently
    # turning the result into "no submodules". Subshell into `/` to break
    # discovery before invoking. `--no-includes` does NOT suffice.
    (cd / && git config --file "$gitmodules" --get-regexp 'submodule\..*\.path' 2>/dev/null) \
        | awk '{print $2}' || true
}
