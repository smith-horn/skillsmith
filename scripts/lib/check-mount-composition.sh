#!/usr/bin/env bash
#
# check-mount-composition.sh — detect runtime child-mount DETACHMENT
# (SMI-6516 broken better-sqlite3 binding + SMI-6520 EROFS: one fault).
#
# THE FAULT, in one sentence: mounts nested under a per-package node_modules
# bind detach from a RUNNING container at runtime; Docker still declares them,
# the named volumes still exist, /proc/self/mountinfo no longer carries them,
# and reads/writes fall through to the READ-ONLY PARENT -- which serves the
# macOS host's Mach-O binary where a Linux ELF is required, and is read-only
# where a write is required.
#
# WHY EVERY CHEAP SIGNAL FAILS HERE (all measured, 2026-09-11):
#   * the file still EXISTS and opens          -> a presence check passes
#   * `docker inspect` still reports RW=true   -> inspect passes
#   * a mount COUNT moves by ONE line (164 vs  -> a count passes while 27-32
#     165) while 27-32 destinations are gone      destinations are missing
#   * both entrypoint summaries print green    -> boot logs pass
# The first signal a human gets is a cryptic failure minutes-to-hours later.
#
# So this checker asserts COMPOSITION, never a total. Its contract is the
# plan's A1-A8 table; each row closes a specific vacuous-pass path and the
# reasons are inline at each implementation site.
#
# SHIPS WARN-ONLY (plan D-20, repo convention): exit 0 even on findings unless
# --strict is passed. A false positive here would fire on every worktree at
# once. Disable entirely: SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1
#
# Usage:
#   check-mount-composition.sh [--root DIR] [--mode worktree|main|auto]
#         [--compose FILE]... [--service NAME] [--mountinfo FILE]
#         [--link-root DIR] [--link-map FILE] [--scope PREFIX]
#         [--live] [--live-write] [--report FILE|--no-report] [--strict] [--quiet]
#
# --live      runs the READ-ONLY probes (A4 ABI identity, A7 undeclared caches,
#             A8 ownership/exec bit). Safe against any container, including one
#             another session is actively using.
# --live-write additionally runs the WRITE probes (A5 traversal writability,
#             A6's direct read-only-parent write test). These create and
#             immediately remove a uniquely-named probe path, so they are
#             opt-in rather than bundled into --live.
#
# Offline/fixture use (no Docker, no container) is the primary test path:
#   --mountinfo <fixture> --compose <fixture> --link-map <fixture>

set -uo pipefail

MC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=check-mount-composition.helpers.sh
source "$MC_DIR/check-mount-composition.helpers.sh"
# shellcheck source=check-mount-composition.identity.sh
source "$MC_DIR/check-mount-composition.identity.sh"

MC_ROOT=""
MC_MODE="auto"
MC_SERVICE="dev"
MC_MOUNTINFO="/proc/self/mountinfo"
MC_SCOPE="/app"
MC_LIVE=0
MC_LIVE_WRITE=0
MC_STRICT=0
MC_QUIET=0
MC_REPORT=""
MC_NO_REPORT=0
MC_COMPOSE=()
export MC_LINK_ROOT="${MC_LINK_ROOT:-}"
export MC_LINK_MAP="${MC_LINK_MAP:-}"

findings=0
checked=0
not_evaluated=0
skipped_by_flag=0

note() { [ "$MC_QUIET" = 1 ] || printf '%s\n' "$*"; }
fail() {
    findings=$((findings + 1))
    [ "$MC_QUIET" = 1 ] || printf 'FAIL [%s] %s\n' "$1" "$2"
}
okline() { [ "$MC_QUIET" = 1 ] || printf 'ok   [%s] %s\n' "$1" "$2"; }

# ADR-151: "a verification that can succeed vacuously must report its
# denominator" -- and a ZERO denominator is not a pass. Zero-of-zero and
# three-of-three both exit 0 today; only one of them means anything.
#
# So an assertion that RAN but examined nothing reports NOT EVALUATED, never
# `ok`, and is blocking under --strict exactly as a finding is. Reachable
# inputs for the A2 case alone: `--service <name that does not exist>`, a
# readable compose file with no matching service, a fresh environment with no
# such topology, and parser drift that silently matches nothing. Every one of
# those printed `ok [A2] all 0 in-scope declared destinations are mounted` and
# exited 0 under --strict before this existed (reproduced, not inferred).
notevaluated() {
    not_evaluated=$((not_evaluated + 1))
    [ "$MC_QUIET" = 1 ] || printf 'NOT EVALUATED [%s] %s\n' "$1" "$2"
}

# Distinct from the above on purpose: the operator DECLINED to run this tier
# (no --live / no --live-write). That is a stated choice with a named cause,
# not an empty denominator, so it does not block under --strict -- but it is
# still not an `ok`, because nothing was asserted.
skipline() {
    skipped_by_flag=$((skipped_by_flag + 1))
    [ "$MC_QUIET" = 1 ] || printf 'SKIP [%s] %s\n' "$1" "$2"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --root) MC_ROOT="$2"; shift 2 ;;
        --mode) MC_MODE="$2"; shift 2 ;;
        --compose) MC_COMPOSE+=("$2"); shift 2 ;;
        --service) MC_SERVICE="$2"; shift 2 ;;
        --mountinfo) MC_MOUNTINFO="$2"; shift 2 ;;
        --link-root) MC_LINK_ROOT="$2"; shift 2 ;;
        --link-map) MC_LINK_MAP="$2"; shift 2 ;;
        --scope) MC_SCOPE="$2"; shift 2 ;;
        --live) MC_LIVE=1; shift ;;
        --live-write) MC_LIVE=1; MC_LIVE_WRITE=1; shift ;;
        --strict) MC_STRICT=1; shift ;;
        --quiet) MC_QUIET=1; shift ;;
        --report) MC_REPORT="$2"; shift 2 ;;
        --no-report) MC_NO_REPORT=1; shift ;;
        -h | --help) sed -n '1,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ "${SKILLSMITH_MOUNT_COMPOSITION_DISABLE:-}" = "1" ]; then
    note "[mount-composition] disabled via SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1"
    exit 0
fi

[ -n "$MC_ROOT" ] || MC_ROOT="$(cd "$MC_DIR/../.." && pwd)"

# --- Mode + expected-inventory source (A1) ---------------------------------
# A1: the expected inventory comes from the COMPOSE FILES, never from what is
# currently mounted. Deriving expectations from actual mounts silently excludes
# exactly the missing ones -- that is the bug, re-created inside its own
# detector. Nothing below ever reads mountinfo to decide what SHOULD be there.
#
# Compose CONCATENATES `volumes:` across -f files (it does not replace them --
# the same behaviour that makes a bare `up -d` in a worktree publish an extra
# port). So a worktree's true declared set is base + override, in that order.
# Measured: the override alone accounts for 138 of a degraded worktree's 140
# surviving in-scope mounts; the missing 2 (/app and
# /app/packages/website/.vercel) come from the base file.
if [ ${#MC_COMPOSE[@]} -eq 0 ]; then
    if [ "$MC_MODE" = "auto" ]; then
        if [ -f "$MC_ROOT/docker-compose.override.yml" ]; then MC_MODE="worktree"; else MC_MODE="main"; fi
    fi
    [ -f "$MC_ROOT/docker-compose.yml" ] && MC_COMPOSE+=("$MC_ROOT/docker-compose.yml")
    if [ "$MC_MODE" = "worktree" ] && [ -f "$MC_ROOT/docker-compose.override.yml" ]; then
        MC_COMPOSE+=("$MC_ROOT/docker-compose.override.yml")
    fi
fi

if [ ${#MC_COMPOSE[@]} -eq 0 ]; then
    fail A1 "no compose file to derive the expected inventory from (root=$MC_ROOT)"
    [ "$MC_STRICT" = 1 ] && exit 1
    exit 0
fi

tmp="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$tmp'" EXIT

: >"$tmp/declared.tsv"
parse_errors=0
for cf in "${MC_COMPOSE[@]}"; do
    if [ ! -r "$cf" ]; then
        fail A1 "compose file unreadable: $cf"
        continue
    fi
    mc_parse_compose_volumes "$cf" "$MC_SERVICE" >"$tmp/one.tsv" || true
    # A1 (anti-vacuous): an entry the parser cannot classify must NEVER be
    # silently dropped -- a parser bug that shrinks the expected set turns
    # every subsequent assertion into a vacuous pass.
    while IFS=$'\t' read -r _s _d kind opts; do
        [ "$kind" = "PARSE_ERROR" ] || continue
        parse_errors=$((parse_errors + 1))
        fail A1 "unparseable volume entry in $(basename "$cf"): $opts"
    done <"$tmp/one.tsv"
    cat "$tmp/one.tsv" >>"$tmp/declared.tsv"
done

declared_total=$(grep -cv '^$' "$tmp/declared.tsv" || true)
note "[mount-composition] mode=$MC_MODE service=$MC_SERVICE scope=$MC_SCOPE"
note "[mount-composition] compose: ${MC_COMPOSE[*]}"
note "[mount-composition] declared volume entries (all destinations): $declared_total (parse errors: $parse_errors)"

# ADR-151 -- an empty EXPECTED INVENTORY is the root vacuous pass: every
# assertion below is a set operation against it, so zero declared entries makes
# all of them trivially true. Reported here, at the producer, rather than at
# each consumer -- a guard placed downstream of a gated value skips as success
# alongside everything it was meant to guard.
if [ "$declared_total" -eq 0 ]; then
    notevaluated A1 "no volume entries parsed for service '$MC_SERVICE' from ${#MC_COMPOSE[@]} compose file(s) -- the expected inventory is EMPTY, so nothing below can assert anything (wrong --service? wrong compose file? parser drift?)"
fi

# --- Resolve declared destinations into kernel space (A2 + the clamp) ------
# Each declared destination is resolved through the container's own symlinks
# with ".." clamped at root. Without this, a worktree comparison reports ALL
# 165 declared destinations missing -- measured -- because /app/node_modules
# and /app/packages/<pkg>/node_modules are symlinks that escape /app, so the
# kernel records /node_modules/... and /packages/<pkg>/node_modules/...
: >"$tmp/expected.tsv"
while IFS=$'\t' read -r src dst kind opts; do
    [ -n "${dst:-}" ] || continue
    [ "$kind" = "PARSE_ERROR" ] && continue
    case "$dst" in "$MC_SCOPE" | "$MC_SCOPE"/*) ;; *) continue ;; esac
    res="$(mc_resolve_container_path "$dst")"
    if [ "$res" = "MC_ELOOP" ]; then
        fail A2 "symlink loop resolving declared destination $dst"
        continue
    fi
    # The KIND column is carried through (it used to be dropped here). A2's
    # backing check needs to distinguish a long-form `type: tmpfs` entry from a
    # short-form bind whose source happens to read "tmpfs", and reconstructing
    # that downstream from the source string alone is a guess.
    printf '%s\t%s\t%s\t%s\t%s\n' "$res" "$dst" "$src" "$kind" "$opts" >>"$tmp/expected.tsv"
done <"$tmp/declared.tsv"

# Later declarations supersede earlier ones at the same resolved destination
# (Compose's own last-wins semantics for a duplicated destination): a worktree
# override re-declares /app/node_modules as a :ro bind over the base file's
# named volume, and the override is what actually mounts.
# awk last-wins rather than `tac` -- tac is GNU-only and these tests run on
# macOS hosts as well as inside the Linux container.
awk -F'\t' '{ a[$1] = $0 } END { for (k in a) print a[k] }' "$tmp/expected.tsv" |
    sort -t$'\t' -k1,1 >"$tmp/expected.uniq.tsv"
cut -f1 "$tmp/expected.uniq.tsv" | sort -u >"$tmp/expected.set"
expected_n=$(wc -l <"$tmp/expected.set" | tr -d ' ')

# --- Actual mounts (A2 + A3) -----------------------------------------------
if [ ! -r "$MC_MOUNTINFO" ]; then
    fail A2 "mountinfo unreadable: $MC_MOUNTINFO"
    [ "$MC_STRICT" = 1 ] && exit 1
    exit 0
fi
: >"$tmp/actual.tsv"
while IFS=$'\t' read -r mp fstype mode root source; do
    # A3: decode \040 \011 \012 \134 BEFORE comparing. An un-decoded path never
    # matches, turning a present mount into a false "missing".
    printf '%s\t%s\t%s\t%s\t%s\n' "$(mc_unescape "$mp")" "$fstype" "$mode" "$(mc_unescape "$root")" "$source" >>"$tmp/actual.tsv"
done < <(mc_parse_mountinfo "$MC_MOUNTINFO")
cut -f1 "$tmp/actual.tsv" | sort -u >"$tmp/actual.set"

# --- A2: normalized destination-SET diff -----------------------------------
# Never a count, never a byte-identical line comparison. Measured rationale:
# a degraded container showed 164 mountinfo lines against a healthy 165 while
# 27-32 declared destinations were absent -- the surviving ~130 mounts under
# /node_modules dominate the total, so a count is not merely weak here, it is
# blind. A byte-identical comparison is additionally brittle (mount IDs,
# parent IDs, device numbers and option ordering all legitimately vary).
comm -23 "$tmp/expected.set" "$tmp/actual.set" >"$tmp/missing.set"
missing_n=$(wc -l <"$tmp/missing.set" | tr -d ' ')
present_n=$((expected_n - missing_n))
checked=$((checked + expected_n))

note "[mount-composition] in-scope declared destinations: $expected_n | mounted: $present_n | MISSING: $missing_n"

if [ "$expected_n" -eq 0 ]; then
    # ADR-151: zero-of-zero is NOT three-of-three. Do not print `ok`.
    notevaluated A2 "0 of $declared_total declared destination(s) fall within scope $MC_SCOPE -- the destination-set diff had nothing to compare and proves nothing"
elif [ "$missing_n" -gt 0 ]; then
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        decl="$(awk -F'\t' -v k="$m" '$1==k{print $2; exit}' "$tmp/expected.uniq.tsv")"
        srcv="$(awk -F'\t' -v k="$m" '$1==k{print $3; exit}' "$tmp/expected.uniq.tsv")"
        fail A2 "declared but NOT mounted: $m (declared as $decl, source=$srcv)"
    done <"$tmp/missing.set"
    note ""
    note "[mount-composition] REMEDY: an explicit \`docker restart\` re-applies the mount"
    note "  spec. A restart's EXIT CODE says the restart ran, not that the binding works --"
    note "  re-run this checker (and open a database) to confirm."
else
    okline A2 "all $expected_n in-scope declared destinations are mounted"
fi

# --- A2 (second half): BACKING IDENTITY, not just the destination path -------
# A destination-set diff answers "is something mounted here". It does not
# answer "is the RIGHT thing mounted here". MEASURED false-clean, live, on this
# very container: take a healthy container's own mountinfo, rewrite the single
# line for /packages/core/node_modules/better-sqlite3 from its named volume
# (root=/docker/volumes/<proj>_native-seed-core-better-sqlite3/_data, ext4) to
# a virtiofs host bind at the identical mountpoint, and the checker reported
# "167 mounted ... 0 findings", exit 0. If that host path supplies a Mach-O,
# A4 passes too and the container reads clean end to end.
#
# What is compared and what is deliberately NOT compared -- with the reasons --
# is in check-mount-composition.identity.sh's headers. Short version: mount
# IDs, parent IDs, device numbers, option ordering, fstype and a bind's own
# source path all legitimately vary (fstype of a local named volume is ext4
# here and overlay/xfs/btrfs elsewhere; a bind is virtiofs here and the host's
# own fs on a Linux daemon; Docker Desktop strips the virtiofs share prefix
# from a bind's recorded root, and ${HOME}-style sources reach the parser
# unexpanded). Only the volume-vs-bind-vs-tmpfs backing, and a named volume's
# own name, are invariant enough to assert.
backing_checked=0
backing_bad=0
while IFS=$'\t' read -r res dst src kind opts; do
    grep -qxF "$res" "$tmp/actual.set" || continue # absent: already an A2 finding
    a_fstype="$(awk -F'\t' -v k="$res" '$1==k{print $2; exit}' "$tmp/actual.tsv")"
    a_root="$(awk -F'\t' -v k="$res" '$1==k{print $4; exit}' "$tmp/actual.tsv")"
    want="$(mc_declared_backing "$src" "$kind")"
    got="$(mc_actual_backing "$a_fstype" "$a_root")"
    backing_checked=$((backing_checked + 1))
    if ! reason="$(mc_backing_matches "$want" "$got")"; then
        backing_bad=$((backing_bad + 1))
        fail A2 "$res is mounted but SUBSTITUTED: $reason (declared $dst, source=$src, fstype=$a_fstype, root=$a_root)"
    fi
done <"$tmp/expected.uniq.tsv"
if [ "$backing_checked" -eq 0 ]; then
    notevaluated A2 "0 mounted destination(s) had their backing identity compared -- nothing was in scope and present, so a substituted mount could not have been seen"
else
    okline A2 "backing identity (volume/bind/tmpfs + volume name) compared for $backing_checked mounted destination(s); $backing_bad substituted"
fi

# --- A6: the read-only parent must still be read-only -----------------------
# SMI-5560's cross-checkout corruption is the failure this :ro exists to
# prevent; a detached-and-replaced parent silently re-opens it. Mount flags are
# read from the PER-MOUNT options, not the superblock -- measured, a :ro bind
# reports ro in field 6 while its superblock says rw.
ro_checked=0
while IFS=$'\t' read -r res dst src kind opts; do
    case ",$opts," in *,ro,*) ;; *) continue ;; esac
    ro_checked=$((ro_checked + 1))
    amode="$(awk -F'\t' -v k="$res" '$1==k{print $3; exit}' "$tmp/actual.tsv")"
    if [ -z "$amode" ]; then
        fail A6 "declared read-only parent is not mounted at all: $res (declared $dst)"
    elif [ "$amode" != "ro" ]; then
        fail A6 "declared :ro but mounted rw: $res (declared $dst, source=$src, kind=$kind)"
    fi
done <"$tmp/expected.uniq.tsv"
# ADR-151 again: this block used to print NOTHING when ro_checked was 0, which
# reads identically to a clean run in a log. A silent assertion is a vacuous
# one; say so.
if [ "$ro_checked" -gt 0 ]; then
    okline A6 "$ro_checked declared :ro destination(s) mode-checked"
else
    notevaluated A6 "0 declared destination(s) carry the :ro option -- the read-only-parent mode assertion examined nothing"
fi

# --- Live filesystem probes (A4, A5, A6-write, A7, A8) ----------------------
if [ "$MC_LIVE" != 1 ]; then
    skipline A4 "--live not set: the A4/A5/A6-write/A7/A8 filesystem probes did not run (fixture mode)"
else
    source "$MC_DIR/check-mount-composition.probes.sh"
    mc_run_live_probes "$tmp" "$MC_LIVE_WRITE"
fi

# --- Report through the proven host-visible channel --------------------------
# Container ~ is NOT host ~. docker-compose.yml binds ${HOME}/.skillsmith to
# /skillsmith-state read-write and sets SKILLSMITH_STATE_DIR_OVERRIDE to it.
# VERIFIED 2026-09-11 on a real WORKTREE container (not just main): 12 of 12
# Skillsmith dev containers carry the bind, and a file written inside a worktree
# container was read back byte-for-byte on the host.
#
# ONE FILE PER CONTAINER, NOT ONE FILE. That same bind is present in EVERY dev
# container and the override is set in every one of them, so the previous
# single fixed path made all of them write the same host file. MEASURED on this
# machine 2026-09-11: 18 dev containers running, 11 of them with the nested
# per-package mounts detached. Whichever container ran last owned the file, so
# one healthy container's zero-finding report erased the whole degraded fleet's
# findings and a host-side consumer read "clean". The JSON's "host" field
# recorded who wrote last; it prevented nothing.
#
# Key derivation, bounded-ness and the rejected alternatives (notably
# `hostname`, which is the container's short ID and therefore churns on every
# --force-recreate) are documented at mc_report_key in
# check-mount-composition.identity.sh.
if [ "$MC_NO_REPORT" != 1 ]; then
    mc_state_dir="${SKILLSMITH_STATE_DIR_OVERRIDE:-$HOME/.skillsmith}"
    mc_scope_host_path="$(awk -F'\t' -v k="$MC_SCOPE" '$1==k{print $4; exit}' "$tmp/actual.tsv")"
    mc_key="$(mc_report_key "$mc_scope_host_path" "$MC_ROOT")"
    mc_report_derived=0
    if [ -z "$MC_REPORT" ]; then
        MC_REPORT="$mc_state_dir/mount-composition/$mc_key.json"
        mc_report_derived=1
    fi
    mc_report_dir="$(dirname "$MC_REPORT")"
    if mkdir -p "$mc_report_dir" 2>/dev/null; then
        {
            printf '{"schema":2,"at":"%s","report_key":"%s","container":"%s","scope_host_path":"%s",' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mc_key" "$(hostname)" "$mc_scope_host_path"
            printf '"mode":"%s","service":"%s","scope":"%s",' "$MC_MODE" "$MC_SERVICE" "$MC_SCOPE"
            printf '"declared_entries":%s,"parse_errors":%s,"in_scope_expected":%s,"mounted":%s,"missing":%s,' \
                "$declared_total" "$parse_errors" "$expected_n" "$present_n" "$missing_n"
            printf '"backing_checked":%s,"backing_substituted":%s,' "$backing_checked" "$backing_bad"
            printf '"findings":%s,"not_evaluated":%s,"skipped":%s,' "$findings" "$not_evaluated" "$skipped_by_flag"
            printf '"live_probes":%s,"live_write":%s,"missing_destinations":[' "$MC_LIVE" "$MC_LIVE_WRITE"
            first=1
            while IFS= read -r m; do
                [ -n "$m" ] || continue
                [ "$first" = 1 ] || printf ','
                printf '"%s"' "$m"
                first=0
            done <"$tmp/missing.set"
            printf ']}\n'
            # Atomic publish: a reader must never see a half-written report.
            # Same directory, so the rename cannot cross a filesystem.
        } >"$MC_REPORT.tmp.$$" 2>/dev/null &&
            mv -f "$MC_REPORT.tmp.$$" "$MC_REPORT" 2>/dev/null ||
            {
                rm -f "$MC_REPORT.tmp.$$" 2>/dev/null
                note "[mount-composition] could not write report to $MC_REPORT"
            }
        note "[mount-composition] report: $MC_REPORT"
        # Bounded, not merely per-container: a worktree that is deleted stops
        # rewriting its report, so without this the directory would grow by one
        # permanently-stale file per retired worktree. Prune is best-effort and
        # never fails the run. 0 disables.
        #
        # ONLY when the path was DERIVED. An explicit --report names a file in a
        # directory this script does not own, and deleting a caller's unrelated
        # *.json from it would be a surprising destructive side effect of asking
        # for a report.
        mc_ttl="${SKILLSMITH_MOUNT_COMPOSITION_REPORT_TTL_DAYS:-14}"
        if [ "$mc_report_derived" = 1 ]; then
            case "$mc_ttl" in
                '' | 0 | *[!0-9]*) ;;
                *) find "$mc_report_dir" -maxdepth 1 -type f -name '*.json' -mtime "+$mc_ttl" -delete 2>/dev/null || true ;;
            esac
        fi
    fi
fi

# --- Summary: COMPOSITION, never a total ------------------------------------
# The summary names all four quantities. A run with 0 findings and 6 assertions
# NOT EVALUATED is not the same observation as a run with 0 findings and 6
# assertions satisfied, and must not print the same line (ADR-151).
mc_tail="$checked in-scope destination(s) checked; $findings finding(s), $not_evaluated not evaluated, $skipped_by_flag skipped by flag."
if [ "$findings" -gt 0 ] || [ "$not_evaluated" -gt 0 ]; then
    note "[mount-composition] $mc_tail"
    [ "$not_evaluated" -gt 0 ] && note "[mount-composition] a NOT EVALUATED assertion proves nothing; it is blocking under --strict for that reason."
    [ "$MC_STRICT" = 1 ] && exit 1
    note "[mount-composition] warn-only (D-20); pass --strict to make this blocking."
    exit 0
fi
note "[mount-composition] $mc_tail"
exit 0
