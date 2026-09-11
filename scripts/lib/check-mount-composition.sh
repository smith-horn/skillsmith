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

note() { [ "$MC_QUIET" = 1 ] || printf '%s\n' "$*"; }
fail() {
    findings=$((findings + 1))
    [ "$MC_QUIET" = 1 ] || printf 'FAIL [%s] %s\n' "$1" "$2"
}
okline() { [ "$MC_QUIET" = 1 ] || printf 'ok   [%s] %s\n' "$1" "$2"; }

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
    while IFS=$'\t' read -r _s _d opts kind; do
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

# --- Resolve declared destinations into kernel space (A2 + the clamp) ------
# Each declared destination is resolved through the container's own symlinks
# with ".." clamped at root. Without this, a worktree comparison reports ALL
# 165 declared destinations missing -- measured -- because /app/node_modules
# and /app/packages/<pkg>/node_modules are symlinks that escape /app, so the
# kernel records /node_modules/... and /packages/<pkg>/node_modules/...
: >"$tmp/expected.tsv"
while IFS=$'\t' read -r src dst opts kind; do
    [ -n "${dst:-}" ] || continue
    [ "$kind" = "PARSE_ERROR" ] && continue
    case "$dst" in "$MC_SCOPE" | "$MC_SCOPE"/*) ;; *) continue ;; esac
    res="$(mc_resolve_container_path "$dst")"
    if [ "$res" = "MC_ELOOP" ]; then
        fail A2 "symlink loop resolving declared destination $dst"
        continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$res" "$dst" "$src" "$opts" >>"$tmp/expected.tsv"
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

if [ "$missing_n" -gt 0 ]; then
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

# --- A6: the read-only parent must still be read-only -----------------------
# SMI-5560's cross-checkout corruption is the failure this :ro exists to
# prevent; a detached-and-replaced parent silently re-opens it. Mount flags are
# read from the PER-MOUNT options, not the superblock -- measured, a :ro bind
# reports ro in field 6 while its superblock says rw.
ro_checked=0
while IFS=$'\t' read -r res dst src opts; do
    case ",$opts," in *,ro,*) ;; *) continue ;; esac
    ro_checked=$((ro_checked + 1))
    amode="$(awk -F'\t' -v k="$res" '$1==k{print $3; exit}' "$tmp/actual.tsv")"
    if [ -z "$amode" ]; then
        fail A6 "declared read-only parent is not mounted at all: $res (declared $dst)"
    elif [ "$amode" != "ro" ]; then
        fail A6 "declared :ro but mounted rw: $res (declared $dst, source=$src)"
    fi
done <"$tmp/expected.uniq.tsv"
[ "$ro_checked" -gt 0 ] && okline A6 "$ro_checked declared :ro destination(s) mode-checked"

# --- Live filesystem probes (A4, A5, A6-write, A7, A8) ----------------------
if [ "$MC_LIVE" != 1 ]; then
    note "[mount-composition] --live not set: A4/A5/A7/A8 filesystem probes SKIPPED (fixture mode)"
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
if [ "$MC_NO_REPORT" != 1 ]; then
    if [ -z "$MC_REPORT" ]; then
        MC_REPORT="${SKILLSMITH_STATE_DIR_OVERRIDE:-$HOME/.skillsmith}/mount-composition.state"
    fi
    if mkdir -p "$(dirname "$MC_REPORT")" 2>/dev/null; then
        {
            printf '{"schema":1,"at":"%s","host":"%s","mode":"%s","service":"%s","scope":"%s",' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$MC_MODE" "$MC_SERVICE" "$MC_SCOPE"
            printf '"declared_entries":%s,"parse_errors":%s,"in_scope_expected":%s,"mounted":%s,"missing":%s,' \
                "$declared_total" "$parse_errors" "$expected_n" "$present_n" "$missing_n"
            printf '"findings":%s,"live_probes":%s,"live_write":%s,"missing_destinations":[' "$findings" "$MC_LIVE" "$MC_LIVE_WRITE"
            first=1
            while IFS= read -r m; do
                [ -n "$m" ] || continue
                [ "$first" = 1 ] || printf ','
                printf '"%s"' "$m"
                first=0
            done <"$tmp/missing.set"
            printf ']}\n'
        } >"$MC_REPORT" 2>/dev/null || note "[mount-composition] could not write report to $MC_REPORT"
        note "[mount-composition] report: $MC_REPORT"
    fi
fi

# --- Summary: COMPOSITION, never a total ------------------------------------
if [ "$findings" -gt 0 ]; then
    note "[mount-composition] $findings finding(s) across $checked in-scope destination(s) checked."
    [ "$MC_STRICT" = 1 ] && exit 1
    note "[mount-composition] warn-only (D-20); pass --strict to make this blocking."
    exit 0
fi
note "[mount-composition] $checked in-scope destination(s) checked, 0 findings."
exit 0
