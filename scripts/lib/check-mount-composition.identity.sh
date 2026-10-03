#!/usr/bin/env bash
#
# check-mount-composition.identity.sh — mount BACKING identity (A2) plus the
# per-container report key.
#
# Split out of check-mount-composition.helpers.sh purely for the 500-line
# pre-commit gate. Like the helpers file, every function here is side-effect
# free and fixture-drivable.
#
# TWO CONCERNS, both measured on this machine 2026-09-11:
#
#   1. A2 asserted DESTINATION PATHS only. A named volume replaced at the
#      IDENTICAL destination by a host bind therefore read as clean: run live
#      against a healthy container with one mountinfo line rewritten from
#      `... /docker/volumes/<proj>_native-seed-core-better-sqlite3/_data
#      /packages/core/node_modules/better-sqlite3 ... - ext4 /dev/vda1 ...`
#      to a virtiofs bind at the same mountpoint, the checker reported
#      "167 mounted, 0 findings, exit 0". If that host path supplies a Mach-O,
#      A4 passes too. Backing identity is what closes it.
#
#   2. Every container wrote the SAME host report file, because
#      docker-compose.yml binds ${HOME}/.skillsmith into all of them and sets
#      SKILLSMITH_STATE_DIR_OVERRIDE=/skillsmith-state. With 18 containers on
#      this machine and 11 of them degraded at the time of writing, one healthy
#      container's zero-finding report erased the whole fleet's findings.
#
# shellcheck shell=bash

# ---------------------------------------------------------------------------
# A2 -- what a compose DECLARATION asks for.
#
# Prints: tmpfs | bind | volume:<name>
#
# Compose treats a short-form source as a NAMED VOLUME only when it is a bare
# name; anything path-shaped is a bind. `.` matters here and is not
# hypothetical -- docker-compose.yml:40 declares `- .:/app`, which contains no
# "/" and would be misread as a volume named "." by a naive `*/*` test. A
# source still carrying an unexpanded ${VAR} or ~ is path-shaped too and is
# classified as a bind, because its real source is not knowable from the text.
# Case table (11 cases) executed in bash before this was written in.
# ---------------------------------------------------------------------------
mc_declared_backing() {
    local src="$1" kind="${2:-short}"
    [ "$kind" = "tmpfs" ] && {
        printf 'tmpfs'
        return 0
    }
    case "$src" in
        */*) printf 'bind' ;;
        '' | '.' | '..') printf 'bind' ;;
        .* | '~'* | '$'*) printf 'bind' ;;
        *) printf 'volume:%s' "$src" ;;
    esac
}

# ---------------------------------------------------------------------------
# A2 -- what the KERNEL actually has, read from the mountinfo ROOT field (4).
#
# Prints: tmpfs | bind | volume:<name>
#
# WHY THE ROOT FIELD AND NOT fstype OR source:
#   MEASURED 2026-09-11 across three live containers. A local-driver named
#   volume and a host bind are INDISTINGUISHABLE by fstype or by source on a
#   given host, and both differ across hosts:
#     volume, Docker Desktop : fstype=ext4      source=/dev/vda1
#     bind,   Docker Desktop : fstype=virtiofs  source=virtiofs0
#     bind,   plain Linux    : fstype=ext4      source=/dev/...   <- same as a
#                                                                    volume
#   So neither fstype nor source can be asserted as a constant without firing
#   on healthy containers. The ROOT field carries the identity that does
#   survive: Docker's local volume driver always lands a volume at
#   `<docker-data-root>/volumes/<name>/_data`, and only the prefix varies
#   (`/docker/volumes/...` inside Docker Desktop's VM, `/var/lib/docker/...`
#   on a plain daemon, `~/.local/share/docker/...` rootless). The `/volumes/
#   <name>/_data` SUFFIX is the invariant; it is what this matches.
#
# KNOWN LIMIT, stated rather than hidden: a host bind whose own path ends in
# `/volumes/<x>/_data` is misclassified as a volume. No declared bind in this
# repo has that shape (they are all under the repo root, ${HOME}/.claude or
# ${HOME}/.skillsmith), the result is a false FAIL rather than a false pass,
# and the checker ships warn-only (D-20).
#
# tmpfs is checked FIRST and by fstype, which IS portable -- a tmpfs is a
# tmpfs on every host.
# ---------------------------------------------------------------------------
mc_actual_backing() {
    local fstype="$1" root="$2" name
    [ "$fstype" = "tmpfs" ] && {
        printf 'tmpfs'
        return 0
    }
    case "$root" in
        */volumes/*/_data)
            name="${root%/_data}"
            name="${name##*/}"
            printf 'volume:%s' "$name"
            ;;
        *) printf 'bind' ;;
    esac
}

# ---------------------------------------------------------------------------
# A2 -- does the actual backing satisfy the declaration?
#
# Returns 0 on match; on mismatch returns 1 and prints the reason.
#
# Compose prefixes a project-scoped volume with "<project>_", so the declared
# name `native-seed-core-better-sqlite3` legitimately appears as
# `smi-6516-mount-composition_native-seed-core-better-sqlite3` (MEASURED). An
# `external: true` volume carries no prefix, so exact equality is accepted too.
# The separator in the suffix test is deliberate: `_<name>` and not `<name>`,
# so `corenode_modules` does NOT satisfy a declared `node_modules`.
#
# A declared BIND's SOURCE PATH is deliberately NOT compared. Two independent
# reasons, both measured: Docker Desktop records the bind root with the
# virtiofs share prefix stripped (declared
# `/Users/williamsmith/.../packages/core/node_modules`, recorded
# `/williamsmith/.../packages/core/node_modules`), and compose sources such as
# `${HOME}/.skillsmith` reach the parser unexpanded. Comparing the text would
# report every bind on this machine as wrong. What IS asserted is the part
# that carries the fault: a bind may not stand in for a volume, or vice versa.
# ---------------------------------------------------------------------------
mc_backing_matches() {
    local want="$1" got="$2" wname gname
    case "$want" in
        tmpfs)
            [ "$got" = "tmpfs" ] && return 0
            printf 'declared tmpfs but backed by %s' "$got"
            return 1
            ;;
        bind)
            [ "$got" = "bind" ] && return 0
            printf 'declared a host bind but backed by %s' "$got"
            return 1
            ;;
        volume:*)
            wname="${want#volume:}"
            case "$got" in
                volume:*) gname="${got#volume:}" ;;
                *)
                    printf 'declared named volume %s but backed by %s' "$wname" "$got"
                    return 1
                    ;;
            esac
            [ "$gname" = "$wname" ] && return 0
            case "$gname" in *"_$wname") return 0 ;; esac
            printf 'declared named volume %s but the mounted volume is %s' "$wname" "$gname"
            return 1
            ;;
    esac
    printf 'unclassifiable declaration: %s' "$want"
    return 1
}

# ---------------------------------------------------------------------------
# A4 -- where the SEED for a declared native target lives in the image, so a
# stale-but-ABI-correct copy is catchable.
#
# Prints the seed directory, or nothing when this destination has no seed
# reference (which is the common case and must never be treated as a fault).
#
# The image lays the seeds out in three shapes, all [DERIVED] from Dockerfile
# and confirmed present at runtime:
#   Tier-B   Dockerfile:231  /opt/native-seed/tier-b/<repo-root-relative path>
#   Tier-A   Dockerfile:152  /opt/native-seed/<pkg>-<module>   (per-package)
#   Tier-A   Dockerfile:91   /opt/native-seed/<module>         (root)
# Tier-B is tried first because its key is the full relative path and is
# therefore the most specific.
#
# WHY A MISMATCH IS A REAL FAULT: both boot-time seeders gate on PRESENCE, not
# version -- docker-entrypoint.sh:96-99 and
# docker-entrypoint-native-per-package.sh:79-82 both decide `already_seeded`
# from `[ -f "$target/package.json" ]`. A volume that already holds any copy is
# therefore NEVER re-seeded, so a dependency bump leaves the old version in
# place indefinitely. That is exactly the stale seed A4 names.
# ---------------------------------------------------------------------------
mc_seed_reference() {
    local dst="$1" scope="${2:-/app}" rel pkg mod cand
    local base="${MC_NATIVE_SEED_ROOT:-/opt/native-seed}"
    case "$dst" in
        "$scope"/*) rel="${dst#"$scope"/}" ;;
        *) return 0 ;;
    esac
    [ -n "$rel" ] || return 0

    cand="$base/tier-b/$rel"
    [ -d "$cand" ] && {
        printf '%s' "$cand"
        return 0
    }

    case "$rel" in
        packages/*/node_modules/*)
            pkg="${rel#packages/}"
            pkg="${pkg%%/*}"
            mod="${rel#"packages/$pkg/node_modules/"}"
            case "$mod" in */*) return 0 ;; esac
            cand="$base/$pkg-$mod"
            ;;
        node_modules/*)
            mod="${rel#node_modules/}"
            case "$mod" in */*) return 0 ;; esac
            cand="$base/$mod"
            ;;
        *) return 0 ;;
    esac
    [ -d "$cand" ] && printf '%s' "$cand"
    return 0
}

# ---------------------------------------------------------------------------
# Report key -- one report file PER CONTAINER, keyed by something stable.
#
# THE BUG THIS REPLACES: a single shared path. docker-compose.yml:100 binds
# ${HOME}/.skillsmith into EVERY dev container and :113 sets
# SKILLSMITH_STATE_DIR_OVERRIDE=/skillsmith-state, so all 18 containers on this
# machine wrote the same host file. Last writer wins, and the last writer is
# whichever container happened to run most recently -- a healthy one erases a
# degraded fleet's findings. The JSON already carried a "host" field, which
# records who wrote last and prevents nothing.
#
# WHAT THE KEY IS, and why not `hostname`: MEASURED -- `hostname` inside these
# containers is the container's short ID (`ce72c4cfd256`). It survives
# `docker restart` but NOT `docker compose up --force-recreate`, which this
# repo's own troubleshooting recommends routinely, so it would accumulate a new
# stale file on every recreate and is opaque to a host-side reader. The
# mountinfo ROOT of the scope mount is the host path of the bind source --
# MEASURED `/williamsmith/.../.worktrees/smi-6516-mount-composition` in a
# worktree container and `/williamsmith/.../skillsmith` in the main checkout's.
# It is stable across restart AND recreate, distinct per worktree, and directly
# meaningful to whatever reads the report. Accumulation is bounded by the
# caller pruning reports older than a TTL.
#
# Fallbacks, in order, each degrading a known amount:
#   2. MC_ROOT       -- host-side runs, where MC_ROOT is the real path.
#   3. hostname      -- last resort; per-recreate churn, hence the TTL prune.
# ---------------------------------------------------------------------------
mc_sanitize_key() {
    local s="$1"
    s="$(printf '%s' "$s" | tr -c 'A-Za-z0-9._-' '-')"
    while case "$s" in *--*) true ;; *) false ;; esac; do s="${s//--/-}"; done
    s="${s#-}"
    s="${s%-}"
    printf '%s' "${s:-unknown}"
}

# A filename must stay a filename. Truncation keeps the TAIL (the distinctive
# part of a path) and prefixes a digest of the whole value so two long paths
# sharing a tail cannot collide. cksum is POSIX and always present, so there is
# always a digest available.
mc_bounded_key() {
    local k="$1" digest
    [ "${#k}" -le 150 ] && {
        printf '%s' "$k"
        return 0
    }
    digest="$(printf '%s' "$k" | cksum | tr -d ' ' | cut -c1-12)"
    printf 'trunc-%s-%s' "$digest" "${k: -100}"
}

mc_report_key() {
    local scope_host_path="${1:-}" root="${2:-}" raw
    if [ -n "${SKILLSMITH_MOUNT_COMPOSITION_REPORT_KEY:-}" ]; then
        raw="$SKILLSMITH_MOUNT_COMPOSITION_REPORT_KEY"
    elif [ -n "$scope_host_path" ] && [ "$scope_host_path" != "/" ]; then
        raw="$scope_host_path"
    elif [ -n "$root" ] && [ "$root" != "/app" ]; then
        raw="$root"
    else
        raw="$(hostname 2>/dev/null || echo unknown)"
    fi
    mc_bounded_key "$(mc_sanitize_key "$raw")"
}
