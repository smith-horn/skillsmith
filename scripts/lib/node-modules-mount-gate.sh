#!/bin/sh
# scripts/lib/node-modules-mount-gate.sh
# SMI-6614 (ADR-158): mount gate for every node_modules path the `dev`
# service's docker-compose.yml declares as its own volume — the repo root
# plus one per packages/<pkg> that holds a package.json (npm's own
# workspace definition; a leftover empty packages/* directory is not a
# workspace and is skipped, since npm never writes a node_modules there and
# checking it would block every install). Checking only the root misses a
# partial detach — one workspace's node_modules silently unmounted while
# root stays fine — and an `npm install` (or a launcher's `rm -rf` remedy)
# then writes into that workspace's HOST tree undetected. Full incident
# history and code-review trail: docs/internal/implementation/smi-6614-6606-lockfile-drift-classifier.md.
#
# Run this INSIDE the container (e.g. `docker exec -w /app <container> sh
# scripts/lib/node-modules-mount-gate.sh`), cwd-independent — every path
# checked is built from the app-root variable below, never from $PWD.
#
# Parses /proc/self/mountinfo directly rather than calling `mountpoint`:
# `mountpoint -q` returns 0 for ANY mount reachable at a path INCLUDING a
# writable host bind, and it follows symlinks, so it cannot distinguish
# "this exact path is mounted" from "this path resolves, via a symlink, to
# something mounted elsewhere." Matching field 5 (mount point) directly
# against the target, unresolved, closes both gaps.
#
# Exit codes (every consumer maps these the same way):
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
#             zero or more than one currently-visible candidate among the
#             lines matching this target (a cycle or otherwise inconsistent
#             mountinfo) — fails closed rather than guessing.
#   127 — the mountinfo source (see test seam below) cannot be read.
#         stderr: "MOUNT_CHECK_UNAVAILABLE 127".
#
# Matching: mountinfo escapes space/tab/newline/backslash in its path
# fields as \040 \011 \012 \134 (proc(5)) — the target is escaped the same
# way before comparison, so an exact string match against field 5 is
# correct even for a package directory name containing a space. A target
# containing an actual newline byte fails closed (MOUNT_DETACHED, never
# searched) — mountinfo is itself newline-delimited, so a literal newline
# inside one field is not representable there at all.
#
# When several mountinfo lines share a target's mount-point field (a mount
# stacked on top of an earlier one at the identical path), field 1 is each
# line's own mount ID and field 2 its parent mount's ID (proc(5)); a mount
# stacked over an existing one gets that existing mount's ID as its parent.
# The currently-visible mount among the matching lines is whichever one's
# own ID is not listed as another matching line's parent ID (nothing sits
# on top of it) — independent of the lines' order in the file. Exactly one
# such candidate resolves normally; zero or more than one is MOUNT_AMBIGUOUS.
#
# The escaped target is passed to awk via ENVIRON, not `awk -v want="$1"`:
# `-v` assignments undergo awk's own string-literal escape processing, so a
# `\040`/`\134` sequence already produced by the escape step below gets
# decoded back into a raw space/backslash before the comparison runs,
# silently corrupting every match against an escaped path — confirmed
# against both mawk and dash's awk. ENVIRON values are not reprocessed.
#
# What this checks: the SHAPE of a mount's root (`.../volumes/<name>/_data`
# — the data-directory path Docker Desktop, Linux Docker, and Podman all
# use), not who created it — Docker/Podman's own metadata is unreachable
# from inside the container, and even the compose file's own declaration
# doesn't catch a volume that detached at runtime, which is the actual
# incident (SMI-6516) this exists to catch. A host directory deliberately
# laid out to mimic that shape and bind-mounted over a target would pass;
# a package directory created between this script's own glob enumeration
# and the install that follows it (a TOCTOU window a single-process check
# can't close) would also be missed. Both require deliberate or concurrent
# action to exploit — this protects against the passive failure modes
# (an accidental host bind, a volume silently detached on container
# recreate) SMI-6516 through SMI-6614 exist to catch.
#
# A main checkout whose tracked scripts/lib/ tree predates this file makes
# every caller's `sh scripts/lib/node-modules-mount-gate.sh` fail with the
# interpreter's own "No such file or directory" — non-zero, no token, before
# this script's own logic runs. Every caller below is `&&`-chained after
# that invocation, so an old checkout fails closed here too, just via an
# untokened mechanism rather than 32/127 — never a silent pass-through to a
# real npm mutation.
#
# Test seams (env-read only; never forwarded by any real caller via
# `docker exec -e`, so a stray host environment can never redirect this
# check):
#   SKILLSMITH_MOUNT_GATE_APP_ROOT_TEST — default /app. Points the
#     root/packages/* checks at a fixture directory instead of the real
#     container root. Prefixed (not a bare APP_ROOT) because some base
#     images set that name themselves, which would otherwise silently
#     redirect a real check.
#   SKILLSMITH_MOUNT_GATE_MOUNTINFO_TEST — default /proc/self/mountinfo.
#     Reads a fixture mountinfo file (e.g. a real excerpt captured from a
#     running container) instead of this process's own real one.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

APP_ROOT="${SKILLSMITH_MOUNT_GATE_APP_ROOT_TEST:-/app}"
MOUNTINFO_SRC="${SKILLSMITH_MOUNT_GATE_MOUNTINFO_TEST:-/proc/self/mountinfo}"

if [ ! -r "$MOUNTINFO_SRC" ]; then
    echo "MOUNT_CHECK_UNAVAILABLE 127" >&2
    exit 127
fi

_gate_failed=0

# Mountinfo-escapes $1 (space/tab/backslash -> \040/\011/\134, per proc(5)).
_gate_escape() {
    _gate_tab="$(printf '\t')"
    printf '%s' "$1" | sed -e 's/\\/\\134/g' -e 's/ /\\040/g' -e "s/${_gate_tab}/\\\\011/g"
}

# Resolves which mount is currently visible at an escaped target ($1) by
# topology (see header). Prints "<root> <fstype>", "AMBIGUOUS", or "" (no
# match at all). Field 4 is root; fstype is the field immediately after the
# literal "-" separator that follows the variable-length optional-fields
# run — scanned for, never assumed to sit at a fixed field index.
_gate_resolve_visible_mount() {
    _SKILLSMITH_MOUNT_GATE_WANT="$1" awk '
        $5 == ENVIRON["_SKILLSMITH_MOUNT_GATE_WANT"] {
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

# True (rc 0) iff $1 is exactly ".../volumes/<one-path-segment>/_data".
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

# POSIX sh has no nullglob: when nothing exists under packages/ at all,
# "$APP_ROOT/packages/*/" expands to the literal pattern string, and
# `[ -f ... ]` on that literal correctly rejects it, so "zero packages"
# degrades to "the root check alone decides." Glob expansion itself never
# re-splits a matched path on spaces (only unquoted variable expansion
# does), so a package directory with a space in its name needs no extra
# quoting here.
for _gate_pkg_dir in "$APP_ROOT"/packages/*/; do
    [ -f "${_gate_pkg_dir}package.json" ] || continue
    _gate_check_one "${_gate_pkg_dir}node_modules"
done

if [ "$_gate_failed" -eq 1 ]; then
    echo "One or more node_modules paths are detached, not volume-shaped, or ambiguous — recreate from the main checkout: docker compose --profile dev up -d --force-recreate dev" >&2
    exit 32
fi

exit 0
