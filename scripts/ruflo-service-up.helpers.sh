#!/usr/bin/env bash
# scripts/ruflo-service-up.helpers.sh -- linked-worktree and foreign-project
# guards for scripts/ruflo-service-up.sh (H-3(b)/(c), post-merge governance
# retro on PR #2931). Split into this sibling once ruflo-service-up.sh crossed
# the repo's own 500-line pre-commit gate (scripts/check-file-length.mjs).
#
# Sourced by scripts/ruflo-service-up.sh, and by
# scripts/ruflo-federation-test.sh, which sources FOUR functions from this
# file: git_dir_equals_common_dir(), federation_restore_disposition(),
# probe_container_owner(), and federation_restore_checkout_1() (the latter
# two added by the SMI-6744 A1.8 cross-family gate round-1 fix, PR #2937
# class 1). Not meant to be run standalone.
# Depends on the caller having already defined REPO_ROOT, COMPOSE_FILE and
# CONTAINER_NAME. log() and die() are NOT a bare convention the caller must
# happen to honor -- the two fallbacks right below this header define them
# when a sourcing caller (e.g. scripts/ruflo-federation-test.sh) has not,
# so sourcing this file is safe by MECHANISM (S-4, SMI-6744 A1.8 retro), not
# by every caller remembering to predefine both functions first.
#
# bash 3.2-safe (macOS default bash), shellcheck -S warning clean, same
# conventions as the caller.
set -euo pipefail

# S-4 (SMI-6744 A1.8 retro): `declare -F <name>` returns 0 when <name> is a
# defined SHELL FUNCTION and nonzero otherwise -- confirmed live:
# `foo() { :; }; declare -F foo` exits 0, `declare -F not_a_real_fn` exits 1.
# `command -v <name>` is the WRONG predicate here (F-2, round 2 fix): it also
# returns 0 for an EXTERNAL BINARY on PATH with that name -- macOS ships
# /usr/bin/log (the unified-logging CLI), confirmed live on this file's own
# target platform, so the original `command -v log` check found /usr/bin/log
# and short-circuited the `||`, meaning the log() fallback silently never
# installed on macOS at all. So these two lines define log()/die() ONLY when
# the sourcing caller has not already defined its own as a SHELL FUNCTION --
# a caller with its own log()/die() (scripts/ruflo-service-up.sh) is
# unaffected; a caller without die() (scripts/ruflo-federation-test.sh,
# which calls git_dir_equals_common_dir()/federation_restore_checkout_1()
# directly and defines its own log() but not die()) gets a working fallback for die()
# instead of an unbound-function error the first time this file's own die()
# calls fire.
declare -F log >/dev/null 2>&1 || log() { echo "[ruflo-up] $*"; }
declare -F die >/dev/null 2>&1 || die() { echo "[ruflo-up] ERROR: $*" >&2; exit 1; }

# H-3(b) (post-merge governance retro, PR #2931): refuse when run from a
# LINKED git worktree. This script's own header has always said "run from
# the main checkout, never per worktree" (SS3), but nothing enforced it --
# measured live: skillsmith-ruflo-1 was created from a worktree checkout,
# tying this MACHINE-GLOBAL, `restart: unless-stopped` service's identity
# (working_dir, and until H-3(a), image name too) to a checkout that can be
# torn down independently of the service it started (remove-worktree.sh's
# per-worktree teardown/orphan-prune has no way to know this container
# depends on it).
#
# `git rev-parse --git-dir` resolves to a path under
# `<main-repo>/.git/worktrees/<name>` for a linked worktree, and to `.git`
# (or an absolute equivalent) for the main checkout or a plain clone;
# `--git-common-dir` always resolves to the ONE shared `.git` dir every
# worktree of a repo points at. The two differ ONLY for a linked worktree --
# a plain clone or a git export (no `.git/worktrees/` at all) always has
# git-dir == git-common-dir and passes.
#
# Fails CLOSED: if $REPO_ROOT is not inside a git repository at all (a git
# export/tarball with no .git present), refuse too -- this script's
# volume/authority-file bookkeeping assumes a real checkout, not an
# unversioned tree, and "cannot determine" is not the same as "verified
# safe".
#
# Test seam: RUFLO_UP_SKIP_WORKTREE_GATE=1 bypasses this check. TEST-ONLY --
# scripts/tests/ruflo-service-up.test.sh's own fixture arms run this real
# script at its real on-disk path, which in an interactive dev worktree
# genuinely IS a linked worktree; those arms are not exercising THIS gate
# and set the seam so their pass/fail reflects volume/store logic only.
# Never set this outside a test.
#
# L-B (SMI-6744 A1.8 retro): the git-dir == git-common-dir normalization
# below is the ONE tested, correctness-bearing predicate for "is <dir> a
# linked worktree" -- it used to be duplicated (equivalent, but with no
# shared source and no declared sweep) in
# scripts/ruflo-federation-test.sh's own checkout_shape_ok(), which now
# calls git_dir_equals_common_dir() below instead. If you add a THIRD
# caller, call the shared function too rather than re-deriving this.
#
# git_dir_equals_common_dir <dir>: prints nothing, never dies. Returns 0 if
# <dir>'s git-dir and git-common-dir resolve to the SAME normalized,
# symlink-resolved path (a main checkout, a plain clone, or an
# unversioned tree is NOT distinguished here -- see check_not_linked_worktree()
# below for the fail-closed "cannot determine" handling a caller may want).
# Returns 1 for a linked worktree, OR when either rev-parse is empty
# (fails closed: "cannot determine" is treated as "not equal").
#
# S-2 (SMI-6744 A1.8 retro): both `git -C <dir> rev-parse` calls below are
# prefixed with `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR` --
# measured live with git 2.50.0: an INHERITED GIT_DIR in the calling
# environment makes `git -C <dir> rev-parse --git-dir` answer for the
# EXPORTED dir instead of resolving from <dir> itself, so without this
# prefix the gate WRONGLY PASSES (returns 0, "not a linked worktree") on a
# genuinely linked worktree whenever GIT_DIR happens to be set. `env -u`
# unsets the var for the duration of that one command only -- it does not
# touch this shell's own environment.
git_dir_equals_common_dir() {
    local dir="$1" gdir cdir
    gdir="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR git -C "$dir" rev-parse --git-dir 2>/dev/null || true)"
    cdir="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR git -C "$dir" rev-parse --git-common-dir 2>/dev/null || true)"
    [[ -n "$gdir" && -n "$cdir" ]] || return 1
    # Normalize to absolute, symlink-resolved paths before comparing: git
    # can print either an absolute path or one relative to <dir> depending
    # on git version, and a bare string compare of a relative ".git"
    # against an absolute linked-worktree path would falsely differ even
    # for the main checkout.
    case "$gdir" in
        /*) : ;;
        *) gdir="$dir/$gdir" ;;
    esac
    case "$cdir" in
        /*) : ;;
        *) cdir="$dir/$cdir" ;;
    esac
    gdir="$(cd "$gdir" 2>/dev/null && pwd -P || printf '%s' "$gdir")"
    cdir="$(cd "$cdir" 2>/dev/null && pwd -P || printf '%s' "$cdir")"
    [[ "$gdir" == "$cdir" ]]
}

check_not_linked_worktree() {
    if [[ "${RUFLO_UP_SKIP_WORKTREE_GATE:-}" == "1" ]]; then
        return 0
    fi
    local git_dir git_common_dir main_checkout
    # S-2 (SMI-6744 A1.8 retro): same env -u prefix as
    # git_dir_equals_common_dir() above -- these two reads exist only to
    # NAME the resolved paths in the die() message below; the pass/fail
    # DECISION itself comes from git_dir_equals_common_dir(), which already
    # carries the fix. Without the prefix here too, an inherited GIT_DIR
    # would make the die() message itself report the wrong (exported) path.
    git_dir="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null || true)"
    if [[ -z "$git_dir" ]]; then
        die "$REPO_ROOT is not inside a git repository (git rev-parse --git-dir failed) -- refusing to run outside a real checkout (fail closed; SS3: run from the main checkout, never per worktree)"
    fi
    git_common_dir="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -z "$git_common_dir" ]]; then
        die "$REPO_ROOT: git rev-parse --git-common-dir failed -- cannot determine whether this is a linked worktree; refusing (fail closed)"
    fi
    if ! git_dir_equals_common_dir "$REPO_ROOT"; then
        # The pass/fail DECISION above already came from the shared,
        # singly-sourced predicate. Re-normalize here ONLY to name the two
        # resolved paths and compute main_checkout for the die() message --
        # this is message formatting, not a second copy of the comparison
        # logic itself.
        case "$git_dir" in
            /*) : ;;
            *) git_dir="$REPO_ROOT/$git_dir" ;;
        esac
        case "$git_common_dir" in
            /*) : ;;
            *) git_common_dir="$REPO_ROOT/$git_common_dir" ;;
        esac
        git_dir="$(cd "$git_dir" 2>/dev/null && pwd -P || printf '%s' "$git_dir")"
        git_common_dir="$(cd "$git_common_dir" 2>/dev/null && pwd -P || printf '%s' "$git_common_dir")"
        main_checkout="$(dirname "$git_common_dir")"
        die "$REPO_ROOT is a LINKED git worktree (git-dir $git_dir != git-common-dir $git_common_dir) -- this script's own header requires running it from the main checkout, never per worktree (SS3). Run instead: ( cd \"$main_checkout\" && ./scripts/ruflo-service-up.sh )"
    fi
}

# H-3(c) (post-merge governance retro, PR #2931): before ever attempting
# `up`, refuse if a container already named $CONTAINER_NAME belongs to a
# DIFFERENT Compose project than this checkout. Docker's own container-name
# uniqueness already prevents a silent takeover at the `bring_up_service()`
# step (proven live by scripts/ruflo-federation-test.sh's case A: a foreign
# project's `up` fails with "Conflict ... already in use"), but without this
# check that failure surfaces LATE -- after this checkout's own
# volume/authority-file bookkeeping has already run -- with a bare Docker
# message that names neither the foreign project nor how to resolve it.
# This check fails fast, before any of that work starts.
#
# SMI-6846 (PR #2937 post-merge retro, High): the existence probe below
# routes through probe_container_owner() (further down in this file)
# instead of a bare `docker inspect $CONTAINER_NAME >/dev/null 2>&1` --
# that bare shape maps EVERY nonzero `docker inspect` (daemon unreachable,
# a permission error, an older CLI, a context switch) to "return 0" (no
# foreign-project collision), the identical fail-open shape the
# cross-family gate round 1 on PR #2937 already blocked and fixed in
# probe_container_owner() itself, further down in this same file.
# probe_container_owner() classifies a nonzero `docker inspect` by its
# STDERR TEXT: only a confirmed "No such (container|object)" message means
# absent (fp_exists=0); anything else (daemon down, a permission error, an
# unrecognized flag, or an unclassified failure) means UNKNOWN
# (fp_exists=""), and this function refuses in that case rather than
# assuming "no foreign-project collision" -- "could not determine" is not
# "verified absent". Bash resolves functions at call time, so it does not
# matter that probe_container_owner() is defined lower in this file.
check_foreign_project() {
    local fp_exists fp_owner
    probe_container_owner "$CONTAINER_NAME" fp_exists fp_owner
    if [[ "$fp_exists" == "0" ]]; then
        return 0
    fi
    if [[ "$fp_exists" != "1" ]]; then
        die "container $CONTAINER_NAME: docker inspect failed for a reason other than a confirmed 'No such container' (see the probe diagnostic above) -- refusing to assume there is no foreign-project collision. Inspect it: docker inspect --type container $CONTAINER_NAME"
    fi
    command -v jq >/dev/null 2>&1 || die "jq is required to check for a foreign-project container collision (docker compose config --format json | jq -r .name) but was not found on PATH"
    local this_project container_project container_workdir
    this_project="$(docker compose -f "$COMPOSE_FILE" config --format json 2>/dev/null | jq -r '.name // empty')"
    [[ -n "$this_project" ]] || die "could not resolve this checkout's Compose project name: docker compose -f $COMPOSE_FILE config --format json | jq -r .name"
    container_project="$fp_owner"
    container_workdir="$(docker inspect --type container "$CONTAINER_NAME" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
    # Cross-family gate round 1 on PR #2934 (Medium): an EMPTY label read --
    # the inspect failed, or the container carries no Compose project label
    # at all (started by hand, or by a tool that is not Compose) -- used to
    # fall through as "no foreign project" and let `up` reconcile it. That is
    # the fail-open shape this check exists to close; "could not read" is not
    # "ours". Refuse and say how to look.
    # F-7 (SMI-6744 A1.8 retro round 2): Docker's own --format template
    # engine prints the literal string "<no value>" (not an empty string)
    # for a missing map key -- measured live -- so a bare `-z` check alone
    # let that shape slip through as "readable" when it is really the SAME
    # "could not attribute" case the empty-string branch already refuses.
    if [[ -z "$container_project" || "$container_project" == "<no value>" ]]; then
        die "container $CONTAINER_NAME already exists but its Compose project label could not be read (empty, the literal '<no value>', or the inspect failed) -- refusing to assume it belongs to this checkout ($this_project). Inspect it: docker inspect $CONTAINER_NAME --format '{{index .Config.Labels \"com.docker.compose.project\"}}' -- if it is not Compose-managed, stop it first and remove it by hand: docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
    fi
    if [[ "$container_project" != "$this_project" ]]; then
        if [[ -d "$container_workdir" ]]; then
            die "container $CONTAINER_NAME already exists and belongs to a DIFFERENT Compose project ($container_project, working_dir=$container_workdir) than this checkout's project ($this_project) -- refusing to reconcile silently into a takeover. Remediation: ( cd \"$container_workdir\" && docker compose --profile ruflo down ruflo ) from THAT project first, then re-run this script."
        else
            die "container $CONTAINER_NAME already exists and belongs to a DIFFERENT Compose project ($container_project, working_dir=$container_workdir) than this checkout's project ($this_project) -- refusing to reconcile silently into a takeover. Its own working_dir no longer exists on this machine, so its project can't stop it gracefully -- stop it first (never rm -f a running container), then remove it: docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
        fi
    fi
}

# federation_restore_disposition <exists:0|1> <owner> <p1> <p2> -- S-1
# (SMI-6744 A1.8 retro): a PURE, arg-taking decision function extracted from
# scripts/ruflo-federation-test.sh's restore_checkout_1() EXIT trap. Prints
# exactly one of four dispositions on stdout and always returns 0 (the
# CALLER acts on the printed word, never on this function's own exit code):
#
#   absent               -- <exists> is the literal "0": $CONTAINER_NAME does
#                            not exist, nothing to remove, proceed straight
#                            to the re-up.
#   refuse-unattributable -- EITHER <exists> is anything other than "0" or
#                            "1" (F-6, SMI-6744 A1.8 retro round 2: the
#                            original `[[ "$exists" -ne 1 ]]` arithmetic
#                            compare treated an unrecognized/malformed
#                            <exists> -- "", "abc", "2" -- as "not 1", which
#                            fell through to "absent", the PERMISSIVE branch;
#                            measured live in bash -- confirmed non-numeric
#                            and empty strings do not error `-ne`, they just
#                            compare false-ish and land on "absent". This is
#                            now fail-CLOSED instead: only the literal "0"
#                            means absent, everything else that isn't "1"
#                            refuses), OR the container EXISTS (exists=1) but
#                            <owner> is EMPTY or the literal string
#                            "<no value>" (F-7, SMI-6744 A1.8 retro round 2:
#                            Docker's own --format template engine prints
#                            this literal, not an empty string, for a
#                            missing map key -- measured live). An
#                            empty/no-value owner previously fell through the
#                            old inline check's `[[ -n "$owner" && "$owner"
#                            != P1 && "$owner" != P2 ]]` condition (empty
#                            owner makes `-n "$owner"` false, short-circuiting
#                            the whole AND to false, i.e. "not foreign" --
#                            exactly backwards) straight into `docker rm -f`,
#                            the ONE command check_foreign_project()'s own
#                            refusal says never to use. Docker itself prints
#                            an empty string (or "<no value>") with exit 0
#                            for a missing label key (measured) -- "could not
#                            attribute" is not "safe to remove".
#   refuse-third          -- the container exists (exists=1) and <owner> is
#                            neither <p1> nor <p2>: a genuine third project's
#                            container.
#   proceed               -- the container exists (exists=1) and <owner> is
#                            <p1> or <p2>: this test's own container from an
#                            earlier run; safe to rm -f and recreate.
#
# No docker/git call inside this function -- callers own probing <exists>
# and <owner> themselves (via `docker inspect`), which is what makes this
# testable by direct invocation with no Docker daemon (scripts/tests/
# ruflo-service-up.test.sh's Arm 16).
federation_restore_disposition() {
    local exists="$1" owner="$2" p1="$3" p2="$4"
    if [[ "$exists" == "0" ]]; then
        echo "absent"
        return 0
    fi
    if [[ "$exists" != "1" || -z "$owner" || "$owner" == "<no value>" ]]; then
        echo "refuse-unattributable"
        return 0
    fi
    if [[ "$owner" != "$p1" && "$owner" != "$p2" ]]; then
        echo "refuse-third"
        return 0
    fi
    echo "proceed"
    return 0
}

# probe_container_owner <name> <exists_var> <owner_var> -- cross-family
# pre-merge gate round 1 on PR #2937 (GPT-5.6-Sol, High, class 1):
# scripts/ruflo-federation-test.sh's OLD restore_checkout_1() mapped EVERY
# nonzero `docker inspect` result to exists=0 ("absent"), which then let
# federation_restore_disposition()'s absent|proceed branch run `docker rm
# -f`. That is fail-OPEN: an existing FOREIGN container could be removed
# if the inspection failed transiently, because of a daemon/permission
# error, or because an older Docker CLI rejects `--type` -- the one-call
# design cannot yield exists=1 with a wrong owner, but its failure branch
# incorrectly asserted absence.
#
# Measured on this host (Docker client 29.7.2), classified from the SAME
# one-call shape the caller already uses:
#
#   absent (no such container)      : exit 1, stderr "Error response from
#                                      daemon: No such container: NAME"
#                                      (or, on an older CLI, "Error: No
#                                      such object: NAME")
#   name is a volume, not a
#     container (--type container)  : exit 1, the SAME "No such
#                                      container: NAME" text
#   daemon unreachable               : exit 1 -- the SAME exit code as
#                                      absent -- stderr "failed to connect
#                                      to the docker API at unix:///..."
#   unknown flag (older CLI)         : exit 125, stderr "unknown flag:
#                                      ..."
#   present                          : exit 0, stdout is the label value
#                                      (or the literal "<no value>" for a
#                                      missing label key --
#                                      federation_restore_disposition()
#                                      above already handles that)
#
# Absent and daemon-down share exit code 1 -- the exit code alone cannot
# separate them, only the stderr TEXT can. So: exit 0 -> exists=1 (a
# confirmed read, however empty); nonzero AND stderr matches
# /no such (container|object)/i -> exists=0 (POSITIVELY established
# absence); ANY OTHER nonzero (daemon down, a permission error, an
# unknown flag, rc 125, or empty stderr) -> exists="" (unknown, not
# absence), and this function prints one diagnostic line to STDERR (never
# stdout) so an unrecognized failure is never silent. Only a positively
# established absence may produce "absent" -- everything else that is not
# a confirmed existence read produces the unknown state, which
# federation_restore_disposition() already maps to refuse-unattributable
# (arm 16f) with no change needed to that function -- the classifier and
# the disposition compose as-is.
#
# stderr is captured to a `mktemp` file under "${TMPDIR:-/tmp}" and
# removed before this function returns; if `mktemp` itself fails, there is
# no stderr text to classify by, so that is treated as unknown too (never
# as absence).
#
# Bash 3.2-safe out-params: `local -n`/namerefs are bash 4.3+, so the two
# results are written back with `printf -v "$2" '%s' ...` / `printf -v
# "$3" '%s' ...` instead of a nameref. Always returns 0 -- the caller
# reads $2/$3, never this function's own exit status.
#
# Measured live (not just reasoned about): a first draft of this function
# declared its own working locals as plain `exists`/`owner` -- exactly the
# names federation_restore_checkout_1() below passes as $2/$3 -- so
# `printf -v "$exists_var" ...` resolved to THIS function's own
# same-named local (bash's normal lexical shadowing), never reaching the
# caller's variable; the caller read back empty every time. Confirmed with
# `bash -x`: federation_restore_disposition() was called with `'' ''`
# instead of `0 ''` for a positively-established absence. Every internal
# local below is therefore prefixed `_poc_` so it cannot collide with
# whatever names a caller chooses for its own $2/$3.
probe_container_owner() {
    local _poc_name="$1" _poc_exists_var="$2" _poc_owner_var="$3"
    local _poc_stderr_file _poc_rc _poc_exists _poc_owner _poc_stderr_text
    _poc_stderr_file="$(mktemp "${TMPDIR:-/tmp}/probe_container_owner.XXXXXX" 2>/dev/null || true)"
    if [[ -z "$_poc_stderr_file" ]]; then
        _poc_exists=""
        _poc_owner=""
        echo "[ruflo-up] probe_container_owner: docker inspect of $_poc_name failed (could not create a temp file to capture stderr), not treating it as absence" >&2
        printf -v "$_poc_exists_var" '%s' "$_poc_exists"
        printf -v "$_poc_owner_var" '%s' "$_poc_owner"
        return 0
    fi
    if _poc_owner="$(docker inspect --type container "$_poc_name" \
        --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>"$_poc_stderr_file")"; then
        _poc_exists=1
    else
        _poc_rc=$?
        _poc_exists=0
        _poc_stderr_text="$(tr '\n' ' ' < "$_poc_stderr_file" 2>/dev/null || true)"
        rm -f "$_poc_stderr_file"
        if ! grep -qiE 'no such (container|object)' <<<"$_poc_stderr_text"; then
            _poc_exists=""
            echo "[ruflo-up] probe_container_owner: docker inspect of $_poc_name failed (rc=$_poc_rc), not treating it as absence: $_poc_stderr_text" >&2
        fi
        _poc_owner=""
        printf -v "$_poc_exists_var" '%s' "$_poc_exists"
        printf -v "$_poc_owner_var" '%s' "$_poc_owner"
        return 0
    fi
    rm -f "$_poc_stderr_file"
    printf -v "$_poc_exists_var" '%s' "$_poc_exists"
    printf -v "$_poc_owner_var" '%s' "$_poc_owner"
    return 0
}

# federation_restore_checkout_1 <container_name> <p1> <p2> <checkout_1>
# <service_touched> -- the body of scripts/ruflo-federation-test.sh's own
# restore_checkout_1() EXIT trap (S-1, SMI-6744 A1.8 retro), moved here
# with EXPLICIT arguments instead of reading the caller's globals, so
# scripts/tests/ruflo-service-up.test.sh can drive the whole restore path
# end to end (arms 20a-20c) with a fake docker on PATH, not only unit-test
# the pure federation_restore_disposition() decision function above.
federation_restore_checkout_1() {
    local container_name="$1" p1="$2" p2="$3" checkout_1="$4" service_touched="$5"
    local rc=0
    if [[ "$service_touched" -ne 1 ]]; then
        log "EXIT trap: the service was never touched (a precondition refused first) -- nothing to restore"
        return 0
    fi
    log "EXIT trap: removing checkout 2's container (if present) and re-running $checkout_1/scripts/ruflo-service-up.sh to restore the shared service"
    # S-1 (SMI-6744 A1.8 retro): the decision of what to do with an existing
    # $container_name is delegated entirely to federation_restore_disposition()
    # (above in this file) -- a pure function taking (exists, owner, p1, p2)
    # and printing one of absent/refuse-unattributable/refuse-third/proceed.
    # This replaced an inline `[[ -n "$owner" && "$owner" != P1 && "$owner"
    # != P2 ]]` check that let an EMPTY $owner (a hand-started container, a
    # non-Compose tool, or a failed inspect -- Docker prints an empty string
    # with exit 0 for a missing label key, measured) fall through to `docker
    # rm -f`, the exact command check_foreign_project()'s own refusal says
    # never to use: `-n "$owner"` is false when $owner is empty, which
    # short-circuits the whole AND to false ("not foreign"), exactly
    # backwards. If checkout 1's ruflo-service-up.sh refused at its own
    # check_foreign_project() (a THIRD project's container already sits at
    # $container_name), $service_touched is already latched by the time this
    # runs -- an unconditional `rm -f` would convert that deliberate refusal
    # into exactly the silent takeover H-3(c) exists to prevent.
    # F-4 (SMI-6744 A1.8 retro round 2; corrected by the cross-family gate
    # round 1 on PR #2937, High, class 1): ONE `docker inspect` call, not two
    # -- the original two-call shape (a plain existence probe, then a second
    # --format call) reads two DIFFERENT snapshots of the container's state:
    # if it is removed by something else between the two calls, the first
    # call sees it exist (exists=1) but the second inspect then fails,
    # leaving owner="" -- which federation_restore_disposition() reads as
    # refuse-unattributable, not the exists=0 "absent" this really is. A
    # single --format call answers both facts from ONE snapshot: it exits 0
    # (with the label value, however empty) when the container exists, BUT a
    # nonzero exit does NOT mean "the container does not exist" -- it also
    # covers daemon/permission failures and an older CLI rejecting --type
    # (measured: absent and daemon-down share the SAME exit code, 1), which
    # is why probe_container_owner() (above in this file) classifies the
    # stderr TEXT instead of trusting the exit code alone.
    local exists owner
    probe_container_owner "$container_name" exists owner
    local disposition
    disposition="$(federation_restore_disposition "$exists" "$owner" "$p1" "$p2")"
    case "$disposition" in
        refuse-unattributable)
            echo "[ruflo-federation] EXIT trap: $container_name exists but its Compose project label could not be read (empty label, the literal '<no value>', or an inspect that failed for a reason other than a confirmed 'No such container') -- refusing to rm -f it (ruflo-service-up.sh's own foreign-project refusal says an unreadable label is never assumed to be ours). Inspect it: docker inspect $container_name --format '{{index .Config.Labels \"com.docker.compose.project\"}}' -- then re-run checkout 1's up script once resolved: $checkout_1/scripts/ruflo-service-up.sh" >&2
            return 0
            ;;
        refuse-third)
            echo "[ruflo-federation] EXIT trap: $container_name belongs to a THIRD project ($owner), not checkout 1 ($p1) or checkout 2 ($p2) -- refusing to rm -f it (ruflo-service-up.sh's own foreign-project refusal says stop it first, never rm -f). Resolve it manually, then re-run: $checkout_1/scripts/ruflo-service-up.sh" >&2
            return 0
            ;;
        absent | proceed)
            docker rm -f "$container_name" >/dev/null 2>&1 || true
            if "$checkout_1/scripts/ruflo-service-up.sh" >/tmp/ruflo-federation-restore.log 2>&1; then
                log "restoration: checkout 1's service is back up"
            else
                rc=$?
                echo "[ruflo-federation] RESTORATION FAILED (exit $rc) -- the shared skillsmith-ruflo-1 service may be left down. See /tmp/ruflo-federation-restore.log and re-run: $checkout_1/scripts/ruflo-service-up.sh" >&2
            fi
            ;;
        *)
            echo "[ruflo-federation] EXIT trap: federation_restore_disposition() returned an unrecognized disposition '$disposition' -- refusing to guess; resolve manually and re-run: $checkout_1/scripts/ruflo-service-up.sh" >&2
            return 0
            ;;
    esac
}
