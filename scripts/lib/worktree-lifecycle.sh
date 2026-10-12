#!/usr/bin/env bash
# worktree-lifecycle.sh - worktree liveness derivation and the worktree
# lifecycle lock (SMI-6981). Sourced by prune-orphaned-docker-volumes.sh,
# create-worktree.sh and lib/report-sprawl-containers.sh; defines functions
# only. Requires _lib.sh (error/warn/info/success, sanitize_project_name) to be
# sourced first. Every function takes the main checkout as an explicit
# $main_repo argument: nothing here reads a caller's global.

# The one reader of `git worktree list` for liveness decisions (pruner, creator,
# container report): every such consumer (protected set, control name, container
# report) goes through here, so the status check below cannot be skipped by a
# new caller. Output and status are captured SEPARATELY and the
# listing is emitted only when git exited 0 -- a command that printed some
# records and then failed would otherwise hand back a partial listing (SMI-6981).
# `sed`, never `awk '{print $2}'`: awk stops at the first space, so a worktree
# path containing one truncates and a LIVE worktree reads as unprotected. Tests
# 1e/1f pin this extraction (live-worktree path / main-checkout path).
# `7<&-`: git never inherits the lifecycle lock (fd 7).
enumerate_worktree_paths() {
    local main_repo="$1" raw
    raw="$(git -C "$main_repo" worktree list --porcelain 7<&- 2>/dev/null)" || return 1
    printf '%s\n' "$raw" | sed -n 's/^worktree //p'
}

# worktree_lifecycle_worktrees_dir_readable MAIN -- 0 when MAIN/.worktrees is absent
# (nothing to enumerate) or is a directory this process can read AND search. An
# existing but unreadable/unsearchable one makes every glob below match nothing,
# which reads as "no peers": callers check this FIRST and fail closed.
worktree_lifecycle_worktrees_dir_readable() {
    [[ -e "$1/.worktrees" || -L "$1/.worktrees" ]] || return 0
    [[ -d "$1/.worktrees" && -r "$1/.worktrees" && -x "$1/.worktrees" ]]
}

# worktree_lifecycle_worktrees_dirs MAIN -- every directory directly under
# MAIN/.worktrees, NUL-delimited (no trailing slash), dot-named ones included.
# NUL, not newline: a directory name may contain a newline, which a line reader
# would split into two bogus paths. Read it with
# `while IFS= read -r -d '' d; do ...; done < <(worktree_lifecycle_worktrees_dirs M)`.
# `*/` alone misses `.foo`, whose project name sanitizes to `foo` (leading
# separators are stripped), so an unregistered `.worktrees/.foo` would be invisible
# to the liveness set, the attribution check and the shared-project report. The
# three globs cover `.x`, `..x` and `*`; unmatched globs stay literal and the
# `-d` guard drops them. bash 3.2 safe (no nullglob/dotglob).
worktree_lifecycle_worktrees_dirs() {
    local d
    for d in "$1"/.worktrees/*/ "$1"/.worktrees/.[!.]*/ "$1"/.worktrees/..?*/; do
        [[ -d "$d" ]] || continue
        printf '%s\0' "${d%/}"
    done
}

# derive_protected(): sanitized project names for the captured listing in $1,
# UNIONED with a `.worktrees/*/` scan of the main checkout $2 (names sanitizing
# alike only OVER-protect). sanitize_project_name (_lib.sh) is the single
# sanitizer; its trailing newline keeps consecutive names on separate lines for
# is_protected()'s exact match.
derive_protected() {
    local wt_paths="$1" main_repo="$2" wt_path base
    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        base="$(basename "$wt_path")"
        sanitize_project_name "$base"
    done <<< "$wt_paths"

    local d
    while IFS= read -r -d '' d; do
        sanitize_project_name "$(basename "$d")"
    done < <(worktree_lifecycle_worktrees_dirs "$main_repo")
}

# The positive control is derived INDEPENDENTLY of the listing it checks, from
# this checkout's own toplevel (`git rev-parse --show-toplevel`): a control from
# the same listing as the set cannot fail. Both queries print the PHYSICAL path
# (measured for a symlinked parent, a final-component symlink and a case-differing
# invocation) and sanitize lowercases, so a healthy run is not refused.
derive_checkout_project() {
    local main_repo="$1" top
    top="$(git -C "$main_repo" rev-parse --show-toplevel 7<&- 2>/dev/null)" || return 1
    [[ -n "$top" ]] || return 1
    sanitize_project_name "$(basename "$top")"
}

# derive_protected() alone fails OPEN: an empty listing makes every candidate
# read as unprotected. This wrapper is what every liveness decision calls (the
# pruner, the creator) and it fails closed via error() (exit 1; the caller's
# `|| error` supplies the context). ONE read per
# derivation feeds both the set and the check. The control is POSITIVE, not an
# emptiness test: a failed enumeration leaves the set non-empty (the
# `.worktrees/*/` scan) but missing this checkout's own name.
#
# error() exits only the command-substitution subshell this is called in, so
# EVERY caller must read the result as `x="$(derive_protected_or_die "$m")" ||
# error ...`: a bare or `local x="$(...)"` assignment continues with whatever
# partial output the failed call printed, and inside a function called from an
# `if`/`||` errexit does not stop it (measured on bash 3.2, SMI-6981).
derive_protected_or_die() {
    local main_repo="$1" out self wt_paths
    if ! worktree_lifecycle_worktrees_dir_readable "$main_repo"; then
        error "$main_repo/.worktrees exists but cannot be read and searched -- refusing to proceed: a directory that cannot be listed would read as \"no live worktrees\", so no protected set derived from it can be trusted."
    fi
    if ! wt_paths="$(enumerate_worktree_paths "$main_repo")"; then
        error "\`git worktree list\` failed -- refusing to proceed. A listing from a failed command may be missing later worktrees, so no protected set derived from it can be trusted."
    fi
    out="$(derive_protected "$wt_paths" "$main_repo")"

    if [[ -z "$wt_paths" ]]; then
        error "\`git worktree list\` produced no worktree entry for this checkout -- refusing to proceed. The canonical enumeration returned nothing, so no protected set can be trusted."
    fi
    if ! self="$(derive_checkout_project "$main_repo")"; then
        error "could not independently identify this checkout (\`git rev-parse --show-toplevel\` failed) -- refusing to proceed, because the protected set has no control to be checked against."
    fi
    # A basename made entirely of characters sanitize_project_name strips leaves
    # this empty, and `grep -qxF "" <<< ""` MATCHES (here-strings append a
    # newline), so the guard would pass in the state of maximum danger.
    if [[ -z "$self" ]]; then
        error "this checkout's project name sanitizes to the empty string -- refusing to proceed, because an empty pattern would match an empty protected set and pass vacuously."
    fi

    if ! grep -qxF "$self" <<< "$out"; then
        error "the derived protected set does not contain this checkout's own project name ('$self', from \`git rev-parse --show-toplevel\`) -- refusing to proceed. \`git worktree list\` always lists this checkout, so this script's recovery of its output failed or the listing is wrong. The set may still be non-empty (a populated .worktrees/ contributes entries), which is why emptiness is not what is checked."
    fi
    printf '%s\n' "$out"
}

is_protected() {
    local project="$1" protected_set="$2"
    grep -qxF "$project" <<< "$protected_set"
}

# Skillsmith-BUILT Compose projects that are not worktrees (SMI-7033). The
# ownership label cannot distinguish these from a worktree's resources, and the
# worktree-existence predicate cannot protect them, so they are named here.
# Matches the exact project name OR the `skillsmith-eval-cron-` prefix family
# (any `skillsmith-eval-cron-<suffix>`) -- a prefix match, so it can over-protect
# a lookalike name, which is the safe direction. Never a substring match.
# Lives here (SMI-7089) so the orphan pruner and lib/worktree-project-attribution.sh
# share ONE copy.
is_own_non_worktree_project() {
    case "$1" in
        skillsmith-eval-cron|skillsmith-eval-cron-*) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# The worktree lifecycle lock (SMI-6981, ADR-180)
#
# One kernel-released flock(2) on the git COMMON DIRECTORY inode serialises a
# sanctioned worktree registration (create-worktree.sh) against a per-project
# Docker delete (the orphan pruner). Bash opens the directory read-only on fd 7;
# a short perl child flocks that inherited descriptor and exits, and the lock
# stays with bash's open file description until bash closes fd 7 or dies. No lock
# file exists, so there is nothing to unlink and no takeover or age-based reclaim:
# the kernel is the only releaser. Replacing the directory itself is tampering
# and is DETECTED (fstat of fd 7 against stat of the path) at acquire, at every
# in-lock check, and as the last operation before each delete.
#
# Rules for callers: never run hooks, the pruner or create-worktree.sh while
# holding it; every child that could outlive the section (git, docker) closes
# fd 7 (`7<&-`); short-lived helpers may inherit it; a non-zero
# acquire code is NEVER "acquired". fd 7 is reserved for this lock.
# ---------------------------------------------------------------------------

WORKTREE_LIFECYCLE_LOCK_HELD=0
WORKTREE_LIFECYCLE_LOCK_PATH=""
_WTL_LAST_COMMON=""
_WTL_LAST_WAIT=""
_WTL_LAST_WHO=""

# One perl program, three modes. `acquire` and `same` run against the inherited
# fd 7; `probe` opens the directory independently and must be REFUSED.
# Exit codes are the acquire/assert codes documented below.
IFS= read -r -d '' _WTL_PERL_LOCK <<'PERL' || true
use strict; use warnings;
use Fcntl qw(:flock);
use POSIX qw(EWOULDBLOCK EAGAIN);
use Time::HiRes qw(time sleep);
my ($mode, $common, $wait) = @ARGV;
sub same_inode {
    my @a = stat($_[0]); my @b = stat($common);
    return (@a && @b && $a[0] == $b[0] && $a[1] == $b[1]) ? 1 : 0;
}
sub busy { return ($! == EWOULDBLOCK || $! == EAGAIN) ? 1 : 0; }
if ($mode eq 'acquire') {
    open(my $fh, '<&=', 7) or exit 73;
    my $deadline = time() + $wait;
    until (flock($fh, LOCK_EX | LOCK_NB)) {
        exit 73 unless busy();
        exit 75 if time() >= $deadline;
        sleep(0.1);
    }
    exit(same_inode($fh) ? 0 : 72);
}
if ($mode eq 'same') {
    open(my $fh, '<&=', 7) or exit 70;
    exit(same_inode($fh) ? 0 : 72);
}
if ($mode eq 'probe') {
    open(my $fh, '<', $common) or exit 73;
    exit 74 if flock($fh, LOCK_EX | LOCK_NB);
    exit(busy() ? 0 : 74);
}
exit 2;
PERL

# Fork/TERM/KILL supervisor: runs a command for at most $1 seconds. The child
# gets its own process group so TERM, then (after a 2 s grace) KILL, reaches
# anything it spawned. Exit 124 on timeout, 127 if the command cannot be
# executed, otherwise the child's own status (a signal death becomes 128+n).
# INT, TERM and HUP, or the death of the parent shell (reparenting), are
# forwarded to the child's group and waited out (signal, TERM, 2 s, KILL) before
# exiting 128+n: the group is out of the terminal's foreground group, so
# without this a Ctrl-C leaves the docker CLI to finish AFTER the lock is gone.
# alarm+exec is NOT usable here: the Go docker CLI ignores SIGALRM (measured).
IFS= read -r -d '' _WTL_PERL_BOUNDED <<'PERL' || true
use strict; use warnings; no warnings 'exec';
use POSIX qw(:sys_wait_h);
use Time::HiRes qw(time sleep);
my $secs = shift @ARGV;
my $pid = fork();
defined $pid or exit 127;
if ($pid == 0) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127; }
my %num = (HUP => 1, INT => 2, TERM => 15);
my ($got, $ppid) = ('', getppid());
for my $n (keys %num) { my $name = $n; $SIG{$name} = sub { $got ||= $name }; }
sub status {
    my $s = shift;
    return WIFEXITED($s) ? WEXITSTATUS($s) : (WIFSIGNALED($s) ? 128 + WTERMSIG($s) : 1);
}
sub terminate {
    my $first = shift;
    kill $first, -$pid; kill $first, $pid;
    kill 'TERM', -$pid; kill 'TERM', $pid;
    my $grace = time() + 2;
    while (time() < $grace) {
        my $r = waitpid($pid, WNOHANG);
        last if $r == $pid || $r < 0;
        sleep(0.05);
    }
    kill 'KILL', -$pid; kill 'KILL', $pid;
    waitpid($pid, 0);
}
my $deadline = time() + $secs;
while (1) {
    my $r = waitpid($pid, WNOHANG);
    exit status($?) if $r == $pid;
    exit 127 if $r < 0;
    if ($got || getppid() != $ppid) {
        $got ||= 'HUP';
        terminate($got);
        exit 128 + $num{$got};
    }
    last if time() >= $deadline;
    sleep(0.05);
}
terminate('TERM');
exit 124;
PERL

# Allow-list of filesystems whose flock(2) is known to exclude local processes.
# Darwin: apfs, hfs. Linux: exactly overlayfs and tmpfs, the two strings measured
# with the lock semantics confirmed; ext4/xfs/btrfs are unmeasured and fail
# closed until someone measures them. Network and FUSE filesystems are
# unsupported. Anything unreadable, empty or unlisted returns 1.
worktree_lifecycle_fs_supported() {
    local path="$1" fstype="" line mp opts
    case "$(uname -s 2>/dev/null)" in
        Darwin)
            # The repo's own mount only: `df -P` stats just this path's filesystem,
            # and `mount` is a kernel listing, so no other mount point is touched
            # (a hung SMB/NFS/autofs mount cannot stall this). The mount point is
            # the text after the capacity column, matched as a whole string
            # against the "on <mountpoint> (<type>, ...)" lines: safe across
            # firmlinks, and spaces in a mount point survive.
            line="$(worktree_lifecycle_bounded 5 df -P "$path" 2>/dev/null | sed -n '2p')" || return 1
            [[ "$line" =~ [0-9]+%[[:space:]]+(/.*)$ ]] || return 1
            mp="${BASH_REMATCH[1]}"
            while IFS= read -r line; do
                [[ "$line" == *" on $mp ("* ]] || continue
                opts="${line##* (}"
                fstype="${opts%%,*}"
                fstype="${fstype%)}"
                break
            done < <(mount 2>/dev/null)
            case "$fstype" in apfs|hfs) return 0 ;; esac
            ;;
        Linux)
            fstype="$(stat -f -c %T "$path" 2>/dev/null)" || return 1
            case "$fstype" in overlayfs|tmpfs) return 0 ;; esac
            ;;
    esac
    return 1
}

# Acquire codes: 0 acquired; 2 re-entry refused; 72 lock identity changed;
# 73 common dir unresolvable, not a directory or unopenable; 74 the lock does not
# exclude (self-probe); 75 busy past the deadline; 76 unsupported filesystem;
# 127 perl missing. 70 (assert only): fd 7 is not open.
worktree_lifecycle_lock_acquire() {
    local main_repo="$1" wait_s="$2" who="$3" common rc
    _WTL_LAST_COMMON=""
    _WTL_LAST_WAIT="$wait_s"
    _WTL_LAST_WHO="$who"
    [[ "${WORKTREE_LIFECYCLE_LOCK_HELD:-0}" == 1 ]] && return 2
    command -v perl >/dev/null 2>&1 || return 127
    common="$(git -C "$main_repo" rev-parse --path-format=absolute --git-common-dir 7<&- 2>/dev/null)" || return 73
    [[ -n "$common" && -d "$common" ]] || return 73
    _WTL_LAST_COMMON="$common"
    worktree_lifecycle_fs_supported "$common" || return 76
    exec 7<"$common" || return 73
    if perl -e "$_WTL_PERL_LOCK" -- acquire "$common" "$wait_s" </dev/null; then rc=0; else rc=$?; fi
    if [[ "$rc" -ne 0 ]]; then
        exec 7<&-
        return "$rc"
    fi
    # Positive control on every acquire: an independent open must be refused, or
    # a no-op flock (fcntl emulation, a filesystem that does not exclude) would
    # read as "held".
    if ! perl -e "$_WTL_PERL_LOCK" -- probe "$common" 7<&- </dev/null; then
        exec 7<&-
        return 74
    fi
    WORKTREE_LIFECYCLE_LOCK_HELD=1
    WORKTREE_LIFECYCLE_LOCK_PATH="$common"
    return 0
}

# 0 while fd 7 is still the lock's directory; 70 not held; 72 replaced.
worktree_lifecycle_lock_assert_held() {
    [[ "${WORKTREE_LIFECYCLE_LOCK_HELD:-0}" == 1 ]] || return 70
    perl -e "$_WTL_PERL_LOCK" -- same "$WORKTREE_LIFECYCLE_LOCK_PATH" </dev/null
}

worktree_lifecycle_lock_release() {
    exec 7<&-
    WORKTREE_LIFECYCLE_LOCK_HELD=0
    WORKTREE_LIFECYCLE_LOCK_PATH=""
}

# Wait/timeout tunables: a non-negative integer from the environment, else $2.
_wtl_uint_env() {
    local value="${!1:-}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf '%s' "$2"; fi
}

# Diagnostic text for a non-zero acquire/assert code. Never feeds a decision.
worktree_lifecycle_lock_message() {
    local rc="$1" common="${_WTL_LAST_COMMON:-<unresolved>}" holders="lsof unavailable"
    case "$rc" in
        75)
            if command -v lsof >/dev/null 2>&1; then
                holders="$(lsof -t -- "$common" 2>/dev/null | tr '\n' ' ' || true)"
                holders="PIDs holding it open: ${holders:-none found}"
            fi
            echo "the worktree lifecycle lock is busy: another create-worktree.sh or orphan prune holds it (${_WTL_LAST_WHO} waited ${_WTL_LAST_WAIT}s on $common; $holders). The kernel releases it when its holder exits."
            ;;
        72) echo "the worktree lifecycle lock identity changed: the git common directory $common was replaced while it was held." ;;
        73) echo "could not resolve or open the git common directory (${common}) for the worktree lifecycle lock." ;;
        74) echo "the worktree lifecycle lock on $common does not exclude other processes (a second open acquired it)." ;;
        76) echo "the git common directory $common is on a filesystem the worktree lifecycle lock does not support (apfs/hfs on macOS; overlayfs/tmpfs on Linux)." ;;
        127) echo "perl is required for the worktree lifecycle lock and was not found on PATH." ;;
        2) echo "internal error: the worktree lifecycle lock is already held by this process." ;;
        *) echo "unexpected worktree lifecycle lock failure (code $rc)." ;;
    esac
}

# worktree_lifecycle_bounded SECONDS CMD ARGS... -- see _WTL_PERL_BOUNDED.
# `7<&-`: the command never inherits the lock.
worktree_lifecycle_bounded() {
    local secs="$1"
    shift
    perl -e "$_WTL_PERL_BOUNDED" -- "$secs" "$@" 7<&- </dev/null
}

# The Docker-state helpers and the in-lock gate (_wtl_gate, called below) live in
# lib/worktree-lifecycle-docker.sh, sourced by prune-orphaned-docker-volumes.sh.

# worktree_lifecycle_delete MAIN_REPO PROJECT DRY_RUN KIND NAME EXPECT
#
# The ONE critical section for a liveness-keyed Docker delete (KIND is `volume`
# or `image`; EXPECT as for _wtl_gate). Order: acquire, liveness re-read,
# identity check, Docker re-inspect, then the one bounded delete (an image BY ID).
# Returns 0 when deleted, live now, skipped by the re-inspect (nothing deleted)
# or dry-run. EVERY other outcome exits via error(): the lock, liveness read,
# identity or re-inspect cannot be established, or the delete returned ANY
# nonzero status (timeout, refusal, lost connection, missing binary, signal). A
# failed request's outcome is not knowable from the CLI -- it can be sent, the
# connection lost and the daemon still carry it out after the lock is released
# -- and its output only tells the operator what happened, never decides. One
# refusal therefore ends the run with exit 1; the rest wait for the next run.
#
# Always called from a `||` context, which suppresses errexit inside it, so no
# step relies on errexit: re-reads are `x="$(...)" || error ...` and the delete
# status is captured with if/else.
worktree_lifecycle_delete() {
    local main_repo="$1" project="$2" dry_run="$3" kind="$4" name="$5" expect="$6"
    local rc fresh out drc wait_s rm_timeout
    local -a rm_cmd
    wait_s="$(_wtl_uint_env SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT 30)"
    rm_timeout="$(_wtl_uint_env SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT 60)"

    if worktree_lifecycle_lock_acquire "$main_repo" "$wait_s" pruner; then rc=0; else rc=$?; fi
    if [[ "$rc" -ne 0 ]]; then
        error "$(worktree_lifecycle_lock_message "$rc") Nothing further deleted; re-run once the cause is fixed."
    fi
    fresh="$(derive_protected_or_die "$main_repo")" \
        || error "liveness re-read under the worktree lifecycle lock failed -- deleting nothing further."
    if is_protected "$project" "$fresh"; then
        echo "LIVE NOW: $name (a worktree for '$project' appeared) -- not deleted"
        worktree_lifecycle_lock_release
        return 0
    fi
    if worktree_lifecycle_lock_assert_held; then rc=0; else rc=$?; fi
    if [[ "$rc" -ne 0 ]]; then
        error "worktree lifecycle lock identity could not be confirmed (code $rc; was the git common directory replaced?) -- deleting nothing further."
    fi
    if ! _wtl_gate "$kind" "$name" "$expect"; then
        echo "SKIPPED $kind $name: $_WTL_SKIP -- not deleted"
        worktree_lifecycle_lock_release
        # A container that attached between the scan and this gate leaves the
        # requested resource behind: a failure for the caller (OP_FAILED), unlike a
        # re-created or ownership-lost resource, which is simply not ours any more.
        [[ "${_WTL_SKIP_FAILS:-false}" == true ]] && return 1
        return 0
    fi
    if [[ "$kind" == volume ]]; then
        rm_cmd=(docker volume rm "$name")
    else
        rm_cmd=(docker rmi "$_WTL_RM_TARGET")
    fi
    if [[ "$dry_run" == true ]]; then
        info "[dry-run] would remove $kind $name"
        worktree_lifecycle_lock_release
        return 0
    fi
    if out="$(worktree_lifecycle_bounded "$rm_timeout" "${rm_cmd[@]}" 2>&1)"; then drc=0; else drc=$?; fi
    worktree_lifecycle_lock_release
    case "$drc" in
        0)
            success "  Removed $kind $name"
            ;;
        124)
            error "${rm_cmd[*]} timed out after ${rm_timeout}s: its outcome is UNKNOWN and the daemon may still run it -- deleting nothing further."
            ;;
        *)
            error "${rm_cmd[*]} failed (exit $drc: ${out:-no output}): the outcome of a failed request is UNKNOWN and the daemon may still run it -- deleting nothing further."
            ;;
    esac
    return 0
}
