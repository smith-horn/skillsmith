#!/bin/sh
# scripts/lib/node-modules-mount-gate.sh
# SMI-6614 (ADR-158, round-2b/round-3/round-4): shared mount gate for EVERY
# node_modules directory docker-compose.yml declares as its own named
# volume — not just the root.
#
# Measured 2026-09-14 against skillsmith-dev-1: docker-compose.yml declares
# NINE node_modules named volumes for the `dev` service (lines 41, 71-78,
# repeated 133-143 for `test`) — /app/node_modules plus one per
# packages/<pkg>/node_modules, exactly the set of `packages/*` directories
# holding a package.json (npm's own workspace definition — a leftover empty
# directory, e.g. packages/billing-types after SMI-5119's package removal,
# is not a workspace and is skipped; `npm query .workspace` confirms 8, not
# 9, directories). On SMI-6516 NINE of TEN declared mounts detached
# individually (a partial state, not all-or-nothing) — so checking only the
# root misses exactly the failure mode that incident produced: root
# attached, one workspace's node_modules silently detached, an `npm
# install` (or a launcher's `rm -rf` remedy) writes into THAT workspace's
# HOST tree undetected.
#
# round-3: `mountpoint -q` is the wrong primitive — it returns 0 for ANY
# mount at that path, including a writable host bind, and it FOLLOWS
# SYMLINKS. Measured 2026-09-14: the worktree container
# post-merge-lockfile-drift-classifier-dev-1 has NO mountinfo entry at
# /app/node_modules at all (its real mounts sit at /node_modules and
# /packages/*/node_modules — a different bind-mount layout entirely), yet
# `mountpoint -q /app/node_modules` there returned 0, because /app/node_modules
# is a SYMLINK whose target (/node_modules) genuinely is a mountpoint.
# `mountpoint` cannot distinguish "this exact path is really mounted" from
# "this path resolves, via however many symlink hops, to something that
# happens to be mounted somewhere." This script instead parses
# /proc/self/mountinfo directly, matching the target path's mount point
# field EXACTLY (no symlink resolution) and checking its mount source's
# SHAPE (see "What this checks" below — it is a shape check, not identity).
#
# round-4 (finding 2): which mountinfo LINE is "the" mount at a path used to
# be "the last line in file order" — an unstated assumption about how the
# kernel happens to order /proc/self/mountinfo, not a property proc(5)
# documents. The real rule is mount TOPOLOGY: per proc(5), field 1 is a
# mount's own ID and field 2 is its PARENT mount's ID. When a second mount
# is stacked on top of an existing one at the identical path, the kernel's
# mount tree makes the new mount's parent the mount that was already there
# — so among every line whose field 5 equals a target, the currently
# VISIBLE one is whichever line's own ID is not listed as another
# collected line's parent ID (nothing is stacked on top of it). Verified
# empirically in this container: this holds regardless of which order the
# two lines appear in the file (both orders tested, both stacking
# directions), and a real skillsmith-dev-1 excerpt (no stacking — one line
# per path) still resolves the same as before.
#
# round-4 (finding 1): renamed the concept everywhere. This script cannot
# prove a mount is a genuine Docker/Podman-managed volume — the container
# has no route to Docker/Podman's own metadata, and even a host-side
# docker-compose.yml declaration doesn't catch a volume that detached at
# runtime (SMI-6516, the actual incident this file exists to catch). What
# it CAN check is the mount's SHAPE: does its root end in
# `.../volumes/<name>/_data`, the path shape every major container runtime
# (Docker Desktop, Linux Docker, Podman) uses for a volume's real data
# directory. So: "a mount whose root is a volume data directory," not "a
# named volume" — the header, the exit-code docs, every consumer message,
# and every test title below use that phrasing.
#
# Run this INSIDE the container (e.g. `docker exec -w /app <container> sh
# scripts/lib/node-modules-mount-gate.sh`), cwd-independent — every path
# checked is built from $APP_ROOT, never from $PWD.
#
# Exit codes (every consumer keeps mapping these the same way — unchanged
# contract from round-2b, only the underlying check changed):
#   0   — every declared node_modules path is currently mounted with a root
#         shaped like a volume data directory.
#   32  — at least one is NOT, for one of three distinct reasons (stderr
#         carries one line per failing path, then a single recreate-
#         instruction line):
#           MOUNT_DETACHED <path> — no mountinfo line's mount-point field
#             matches the target exactly. A missing directory ALSO counts
#             as detached, catching a NEW package added to packages/*
#             before its volume line is declared.
#           MOUNT_NOT_VOLUME <path> root=<root> fstype=<fstype> — a mount
#             IS there, but its root is not shaped like a volume data
#             directory — a host bind, tmpfs, or anything else.
#           MOUNT_AMBIGUOUS <path> — the topology resolution below found
#             zero or more than one "currently visible" candidate among the
#             lines matching this target (a cycle or otherwise inconsistent
#             mountinfo) — fails closed rather than guessing.
#   127 — /proc/self/mountinfo (or the override named by
#         NODE_MODULES_MOUNT_GATE_MOUNTINFO) cannot be read. stderr:
#         "MOUNT_CHECK_UNAVAILABLE 127".
#
# Matching: mountinfo escapes space/tab/newline/backslash in its path
# fields as \040 \011 \012 \134 (proc(5)) — the target is escaped the same
# way before comparison, so an exact string match against field 5 is
# correct even for a package directory name containing a space. A target
# containing an actual newline byte fails closed (MOUNT_DETACHED, never
# searched) — mountinfo is itself newline-delimited, so a literal newline
# inside one field is not representable there at all.
#
# What this checks (stated plainly — the residual, not closed by this
# check): a host directory deliberately laid out to mimic
# `.../volumes/<name>/_data` and bind-mounted over a target would pass —
# this checks the SHAPE of a mount's root, not who created it, and Docker/
# Podman's own metadata is unreachable from inside the container. It
# protects against the passive failure modes SMI-6516 through SMI-6614
# exist to catch — a volume silently detached on container recreate, or an
# ordinary host bind landing on a node_modules path by accident — not
# against a deliberately disguised bind an operator inside the container
# chose to construct. A package directory created between this script's
# own glob enumeration and the install that follows it (a TOCTOU window,
# not a design flaw this single-process check can close) is also missed.
#
# Contract note (round-2b, retained): every outcome normalizes to exactly
# one of 0/32/127 rather than a fourth "unexpected error" bucket — strictly
# safer (fail-closed either way) and lets every consumer branch on this
# file's own three codes without re-deriving a lower-level tool's raw ones.
#
# Backward compatibility: a main checkout whose tracked scripts/lib/ tree
# PREDATES this file (i.e. this file itself doesn't exist yet there) makes
# every caller's own `sh scripts/lib/node-modules-mount-gate.sh` fail with
# the interpreter's own "No such file or directory" — a non-zero exit with
# NEITHER token, before this script's own logic ever runs. Every caller
# below is `&&`-chained after that invocation, so the install/rebuild is
# skipped either way: an old checkout fails CLOSED here too, just via a
# different (untokened) mechanism than 32/127 — never a silent pass-through
# to a real npm mutation.
#
# Test seams (env-read only — never forwarded by any real caller via
# `docker exec -e`, same status as the round-2b APP_ROOT seam; SMI-6614
# round-2 Finding A: no test-seam variable is ever forwarded from a
# host/outer process into the container, so a stray host env can never
# redirect this check):
#   APP_ROOT — default /app. Points the root/packages/* checks at a fixture
#     directory instead of the real container root.
#   NODE_MODULES_MOUNT_GATE_MOUNTINFO — default /proc/self/mountinfo. Reads
#     a fixture mountinfo file (e.g. a real excerpt captured from
#     skillsmith-dev-1) instead of this process's own real one.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

APP_ROOT="${APP_ROOT:-/app}"
MOUNTINFO_SRC="${NODE_MODULES_MOUNT_GATE_MOUNTINFO:-/proc/self/mountinfo}"

if [ ! -r "$MOUNTINFO_SRC" ]; then
    echo "MOUNT_CHECK_UNAVAILABLE 127" >&2
    exit 127
fi

_gate_failed=0

# Mountinfo-escapes $1 (space/tab/backslash -> \040/\011/\134, per proc(5)).
# A literal newline can't be escaped into a single mountinfo field at all
# (mountinfo is itself newline-delimited) — callers check for one BEFORE
# calling this, and never search mountinfo for such a target.
_gate_escape() {
    _gate_tab="$(printf '\t')"
    printf '%s' "$1" | sed -e 's/\\/\\134/g' -e 's/ /\\040/g' -e "s/${_gate_tab}/\\\\011/g"
}

# Resolves which mount is currently VISIBLE at an escaped target ($1), by
# mount topology rather than file order (round-4 finding 2). Prints one of:
#   "<root> <fstype>" — exactly one candidate line's ID is not another
#     candidate's parent ID (nothing among the matches is stacked on top of
#     it) — that candidate is the visible mount.
#   "AMBIGUOUS"        — zero or more than one such candidate (a cycle or
#     otherwise inconsistent mountinfo) — the caller fails closed.
#   ""                 — no mountinfo line's field 5 matches the target at
#     all (detached).
# Field 1 is a mount's own ID, field 2 its parent mount's ID (proc(5)) — the
# ID of the mount that was already at this exact mountpoint when a later
# mount was stacked on top of it. Field 4 is root; fstype is the field
# immediately after the literal "-" separator that follows the variable-
# length optional-fields run — scanned for, never assumed to sit at a fixed
# field index.
#
# The escaped target is passed via ENVIRON, NOT `awk -v want="$1"` — measured
# empirically (mawk AND dash+awk, both give the identical wrong answer):
# `-v` assignments undergo awk's own string-literal escape processing (POSIX:
# "as if it occurs in the awk program... preceded and followed by a
# double-quote"), so a `\040`/`\134` sequence already produced by
# _gate_escape() gets DECODED BACK into a raw space/backslash before the
# comparison ever runs — silently corrupting every match against an escaped
# path (e.g. a package directory name containing a space) back to a false
# MOUNT_DETACHED. A value read from ENVIRON is the raw environment string
# with no such reprocessing, confirmed against mawk (this image's /usr/bin/awk)
# and dash's own awk invocation.
_gate_resolve_visible_mount() {
    NODE_MODULES_MOUNT_GATE_WANT="$1" awk '
        $5 == ENVIRON["NODE_MODULES_MOUNT_GATE_WANT"] {
            n++
            id[n] = $1
            parent[n] = $2
            root[n] = $4
            fstype[n] = "?"
            for (i = 6; i <= NF; i++) {
                if ($i == "-") { fstype[n] = $(i + 1); break }
            }
        }
        END {
            if (n == 0) { exit }
            visible_count = 0
            for (i = 1; i <= n; i++) {
                is_parent = 0
                for (j = 1; j <= n; j++) {
                    if (j != i && parent[j] == id[i]) { is_parent = 1; break }
                }
                if (!is_parent) { visible_count++; vi = i }
            }
            if (visible_count == 1) {
                print root[vi] " " fstype[vi]
            } else {
                print "AMBIGUOUS"
            }
        }
    ' "$MOUNTINFO_SRC"
}

# True (rc 0) iff $1 is exactly ".../volumes/<one-path-segment>/_data" — the
# path shape a volume's data directory takes in Docker Desktop
# (/docker/volumes/x/_data), Linux (/var/lib/docker/volumes/x/_data), and
# Podman (.../storage/volumes/x/_data) alike, since all three share this
# common suffix shape regardless of what precedes "volumes/". This checks
# SHAPE only — see the header's "What this checks" section for the residual.
_gate_is_volume_shaped() {
    case "$1" in
        */volumes/*/_data)
            _gate_seg="${1%/_data}"
            _gate_seg="${_gate_seg##*/volumes/}"
            case "$_gate_seg" in
                */* | '') return 1 ;;
                *) return 0 ;;
            esac
            ;;
        *) return 1 ;;
    esac
}

# $1 — absolute path to check.
_gate_check_one() {
    case "$1" in
        *"
"*)
            # A literal newline in the target can never match a mountinfo
            # field (mountinfo is newline-delimited) — fail closed without
            # even attempting to search.
            echo "MOUNT_DETACHED $1" >&2
            _gate_failed=1
            return
            ;;
    esac
    _gate_escaped="$(_gate_escape "$1")"
    _gate_match="$(_gate_resolve_visible_mount "$_gate_escaped")"
    if [ -z "$_gate_match" ]; then
        echo "MOUNT_DETACHED $1" >&2
        _gate_failed=1
        return
    fi
    if [ "$_gate_match" = "AMBIGUOUS" ]; then
        echo "MOUNT_AMBIGUOUS $1" >&2
        _gate_failed=1
        return
    fi
    _gate_root="${_gate_match%% *}"
    _gate_fstype="${_gate_match#* }"
    if ! _gate_is_volume_shaped "$_gate_root"; then
        echo "MOUNT_NOT_VOLUME $1 root=$_gate_root fstype=$_gate_fstype" >&2
        _gate_failed=1
    fi
}

_gate_check_one "$APP_ROOT/node_modules"

# Explicit no-match glob handling (POSIX sh has no nullglob): when nothing
# exists under packages/ at all, "$APP_ROOT/packages/*/" expands to the
# LITERAL pattern string — `[ -f ... ]` on that literal correctly rejects
# it, so "zero packages" degrades to "the root check alone decides." Glob
# expansion itself never re-splits a matched path on spaces (only unquoted
# variable expansion does), so a package directory with a space in its name
# is handled correctly without any extra quoting work here.
#
# Only a directory holding a package.json is an npm workspace, so only
# those are checked. A leftover empty directory (measured 2026-09-14: an
# empty packages/billing-types in the main checkout, left by SMI-5119's
# package removal) is not a workspace, npm never writes a node_modules
# there, and checking it would block every install.
for _gate_pkg_dir in "$APP_ROOT"/packages/*/; do
    [ -f "${_gate_pkg_dir}package.json" ] || continue
    _gate_check_one "${_gate_pkg_dir}node_modules"
done

if [ "$_gate_failed" -eq 1 ]; then
    echo "One or more node_modules paths are detached, not volume-shaped, or ambiguous — recreate from the main checkout: docker compose --profile dev up -d --force-recreate dev" >&2
    exit 32
fi

exit 0
