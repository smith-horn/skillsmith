#!/usr/bin/env bash
#
# check-mount-composition.helpers.sh — pure parsing/normalisation primitives
# for the SMI-6516/SMI-6520 mount-composition checker.
#
# Split out of check-mount-composition.sh purely for the 500-line pre-commit
# gate (lint-staged -> scripts/check-file-length.mjs). Every function here is
# side-effect free and fixture-drivable: no container, no Docker, no network.
# The live probes (ABI identity, writability, uid/gid) live in the main script.
#
# WHY THESE EXIST AT ALL (SMI-6516 draft-2 plan, §1 contract A1-A8):
# the fault this detects is a *runtime child-mount detachment* in which Docker
# still declares a mount, the named volume still exists, and the file at the
# path still opens -- it just falls through to the read-only parent, serving
# the macOS host's Mach-O binary where a Linux ELF is required. Every cheap
# signal (presence, `docker inspect`, a mount COUNT) passes on exactly the
# broken state, so each primitive below is shaped to make a vacuous pass
# impossible rather than to be convenient.
#
# shellcheck shell=bash

# ---------------------------------------------------------------------------
# A3 -- mountinfo path un-escaping.
#
# The kernel escapes four characters in mountinfo fields 4 (root), 5 (mount
# point) and 10 (source): space, tab, newline, backslash. An un-decoded path
# silently never matches a declared destination, which turns a *present* mount
# into a false "missing" -- and, with an inverted test, a false pass. Backslash
# is decoded LAST so that a literal "\134040" decodes to "\040" and not to a
# space.
# ---------------------------------------------------------------------------
mc_unescape() {
    local s="$1"
    s="${s//\\040/ }"
    s="${s//\\011/	}"
    s="${s//\\012/
}"
    s="${s//\\134/\\}"
    printf '%s' "$s"
}

# ---------------------------------------------------------------------------
# Lexical path normalisation with ".." CLAMPED AT ROOT.
#
# This mirrors the kernel's own behaviour and is the whole reason the worktree
# topology works: link_worktree_package_node_modules() writes
#   <worktree>/packages/<pkg>/node_modules -> ../../../../packages/<pkg>/node_modules
# whose depth is correct on the HOST. Inside the container /app *is* the
# worktree, so four ".." hit / and clamp, and the link resolves to
# /packages/<pkg>/node_modules -- OUTSIDE /app. Docker follows symlinks when
# resolving a bind destination, so the mount lands there and the kernel records
# the clamped path. A checker that compares declared "/app/..." destinations
# against mountinfo without reproducing this clamp reports ~165 of 169
# destinations missing: a pure artifact, and the fastest way to build a
# detector nobody trusts.
#
# Validated against a 12-case table before being written here (including
# "/..", "/", "//", "." and embedded-space cases).
# ---------------------------------------------------------------------------
mc_normalize_path() {
    local p="$1" rest comp out="" c
    local -a stack=()
    case "$p" in /*) ;; *) p="/$p" ;; esac
    rest="${p#/}"
    while [ -n "$rest" ]; do
        comp="${rest%%/*}"
        if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
        case "$comp" in
            '' | '.') ;;
            '..')
                if [ ${#stack[@]} -gt 0 ]; then
                    unset 'stack[${#stack[@]}-1]'
                    stack=(${stack[@]+"${stack[@]}"})
                fi
                ;;
            *) stack+=("$comp") ;;
        esac
    done
    for c in ${stack[@]+"${stack[@]}"}; do out="$out/$c"; done
    printf '%s' "${out:-/}"
}

# ---------------------------------------------------------------------------
# Read a symlink literal for a CONTAINER path.
#
# MC_LINK_ROOT lets the resolver run on the HOST while still resolving in
# CONTAINER namespace: the symlink FILE lives on the writable `.:/app` bind, so
# its literal text is byte-identical whether read from the host worktree or
# from inside the container -- only the base depth differs, and the base depth
# is supplied by the container-space path we are resolving. With MC_LINK_ROOT
# unset the literal is read from the container path directly.
#
# Empty output means "not a symlink" (or unreadable); callers must treat those
# two identically -- a path we cannot inspect is reported, never assumed.
# ---------------------------------------------------------------------------
mc_link_literal() {
    # NOTE: `local cpath="$1" probe="$cpath"` is NOT equivalent and must not be
    # reintroduced -- under `set -u` the second initialiser cannot see the first
    # and aborts the function. Because callers invoke this inside $(...), that
    # abort is SILENT: resolution quietly returns the unresolved path and the
    # checker reports every destination missing. Caught only by running the
    # real script under set -u against real data.
    local cpath="$1"
    local probe="$cpath"
    if [ -n "${MC_LINK_ROOT:-}" ]; then
        case "$cpath" in
            /app) probe="$MC_LINK_ROOT" ;;
            /app/*) probe="$MC_LINK_ROOT/${cpath#/app/}" ;;
            *) return 0 ;;
        esac
    fi
    if [ -n "${MC_LINK_MAP:-}" ]; then
        # Fixture mode: a TAB-separated "<container-path>\t<literal>" map.
        # Deliberately exact-match only, so a fixture cannot accidentally
        # satisfy a resolution it did not actually declare.
        awk -F'\t' -v k="$cpath" '$1==k{print $2; found=1; exit} END{exit !found}' \
            "$MC_LINK_MAP" 2>/dev/null || true
        return 0
    fi
    [ -L "$probe" ] || return 0
    readlink "$probe" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Resolve a declared container destination to the path the KERNEL will record,
# following symlinks component by component with ".." clamping.
#
# Bounded at 40 hops (Linux's own ELOOP ceiling) -- a cycle must surface as a
# reported error, never as a hang or a silently truncated resolution.
# ---------------------------------------------------------------------------
mc_resolve_container_path() {
    local target="$1" hops=0
    local acc="" rest comp lit parent
    target="$(mc_normalize_path "$target")"
    rest="${target#/}"
    acc=""
    while [ -n "$rest" ]; do
        comp="${rest%%/*}"
        if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
        [ -z "$comp" ] && continue
        acc="$acc/$comp"
        lit="$(mc_link_literal "$acc")"
        if [ -n "$lit" ]; then
            hops=$((hops + 1))
            if [ "$hops" -gt 40 ]; then
                printf 'MC_ELOOP'
                return 0
            fi
            case "$lit" in
                /*) acc="$(mc_normalize_path "$lit")" ;;
                *)
                    parent="${acc%/*}"
                    [ -z "$parent" ] && parent="/"
                    acc="$(mc_normalize_path "$parent/$lit")"
                    ;;
            esac
        fi
    done
    printf '%s' "${acc:-/}"
}

# ---------------------------------------------------------------------------
# A1 -- expected inventory, parsed from the COMPOSE FILE, never from mounts.
#
# Emits TAB-separated: <source>\t<destination>\t<kind>\t<options>
#   kind = short | tmpfs | PARSE_ERROR
#
# FIELD ORDER IS LOAD-BEARING: <options> is last because it is the only field
# that can be EMPTY, and TAB is an IFS *whitespace* character. `IFS=$'\t' read
# -r a b c d` therefore collapses a run of tabs, so an empty field in the
# MIDDLE silently shifts every later field one position left, while an empty
# field at the END is simply assigned "". Measured:
#   printf 'a\tb\t\td\n' | IFS=$'\t' read -r f1 f2 f3 f4  ->  f3=d, f4=''
# An earlier revision emitted <options> third; every entry without options
# therefore delivered kind="short" into the caller's `opts` variable and left
# `kind` empty. It was harmless only by luck (`case ",short," in *,ro,*` does
# not match), and it broke the moment `kind` was actually consumed.
#
# Scoped to ONE service. This is load-bearing: a generated worktree override
# declares the identical ~163-entry volume list TWICE (services.dev and
# services.test), so an unscoped parse doubles every destination and the
# resulting "expected" set is fiction.
#
# Handles BOTH compose volume forms. The generated override uses long-form
# `type: tmpfs` blocks for the @skillsmith/@smith-horn alias scopes; a parser
# that only understands short-form drops those two destinations silently --
# the exact vacuous-pass shape A1 exists to forbid.
#
# ANY volume entry that cannot be classified is emitted with kind=PARSE_ERROR
# rather than skipped. A parser bug must shrink nothing: it must be loud.
# ---------------------------------------------------------------------------
mc_parse_compose_volumes() {
    local file="$1" service="$2"
    [ -r "$file" ] || return 1
    awk -v want="$service" '
        # Index of the last ":" in s, or 0. awk has no rindex().
        function match_last_colon(s,   i) {
            for (i = length(s); i >= 1; i--) {
                if (substr(s, i, 1) == ":") return i
            }
            return 0
        }
        function flush_tmpfs() {
            if (in_tmpfs && tmpfs_target != "") {
                printf "tmpfs\t%s\ttmpfs\t\n", tmpfs_target
            }
            in_tmpfs = 0; tmpfs_target = ""
        }
        # Top-level keys (column 0) end any service context.
        /^[^[:space:]#]/ {
            flush_tmpfs()
            in_services = ($0 ~ /^services:/)
            in_service = 0; in_volumes = 0
            next
        }
        # Service name at 2-space indent.
        /^  [^[:space:]#][^:]*:[[:space:]]*$/ {
            flush_tmpfs()
            if (in_services) {
                name = $0
                sub(/^  /, "", name); sub(/:[[:space:]]*$/, "", name)
                in_service = (name == want)
                in_volumes = 0
            }
            next
        }
        # Any 4-space key inside the service ends a volumes: block.
        /^    [^[:space:]#][^:]*:/ {
            flush_tmpfs()
            in_volumes = (in_service && $0 ~ /^    volumes:[[:space:]]*$/)
            next
        }
        !in_volumes { next }
        /^[[:space:]]*#/ { next }
        # Long-form continuation lines (8-space) belong to the open item.
        /^        [a-zA-Z_]+:/ {
            if (in_tmpfs) {
                line = $0
                sub(/^[[:space:]]+/, "", line)
                if (line ~ /^target:/) {
                    sub(/^target:[[:space:]]*/, "", line)
                    gsub(/^["'"'"']|["'"'"']$/, "", line)
                    tmpfs_target = line
                }
            }
            next
        }
        # A new list item.
        /^      - / {
            flush_tmpfs()
            item = $0
            sub(/^      - /, "", item)
            sub(/[[:space:]]+#.*$/, "", item)
            sub(/[[:space:]]+$/, "", item)
            if (item == "") next
            if (item ~ /^type:[[:space:]]*tmpfs$/) { in_tmpfs = 1; next }
            if (item ~ /^type:/) {
                # Long-form, non-tmpfs. Not emitted by the generator today; if
                # one ever appears it must be visible, not quietly dropped.
                printf "?\t?\tPARSE_ERROR\t%s\n", item
                next
            }
            gsub(/^["'"'"']|["'"'"']$/, "", item)
            # Splitting naively on ":" is WRONG: a source may legitimately
            # contain a colon inside a shell default-expansion, e.g.
            #   ${HOME}/.claude/projects/${SKILLSMITH_PROJECT_DIR_ENCODED:-}/memory:/skillsmith-memory:ro
            # which naive splitting turns into 4 fields and discards. Instead:
            # peel a RECOGNISED trailing options field, then split at the LAST
            # remaining colon -- a container destination is an absolute path
            # and never contains a colon.
            opts = ""
            rest2 = item
            p = match_last_colon(rest2)
            if (p > 0) {
                tail = substr(rest2, p + 1)
                if (tail ~ /^(ro|rw|z|Z|cached|delegated|consistent|nocopy|rshared|rslave|rprivate)(,(ro|rw|z|Z|cached|delegated|consistent|nocopy|rshared|rslave|rprivate))*$/) {
                    opts = tail
                    rest2 = substr(rest2, 1, p - 1)
                }
            }
            p = match_last_colon(rest2)
            if (p <= 0) { printf "?\t?\tPARSE_ERROR\t%s\n", item; next }
            src = substr(rest2, 1, p - 1)
            dst = substr(rest2, p + 1)
            if (src == "" || dst !~ /^\//) { printf "?\t?\tPARSE_ERROR\t%s\n", item; next }
            printf "%s\t%s\tshort\t%s\n", src, dst, opts
            next
        }
        # Long-form item opener written as "- type: tmpfs" already handled;
        # an 8-space line while no item is open is structural noise.
        { next }
        END { flush_tmpfs() }
    ' "$file"
}

# ---------------------------------------------------------------------------
# A2/A3 -- parse /proc/self/mountinfo into a comparable record set.
#
# Emits TAB-separated: <mountpoint>\t<fstype>\t<effective-mode>\t<root>\t<source>
#
# Field layout:  id parent maj:min root mountpoint opts [optional...] - fstype source superopts
# The optional-field run before "-" is variable-length, so the separator index
# must be FOUND, never assumed.
#
# EFFECTIVE MODE is read from the PER-MOUNT options (field 6), not from the
# superblock options. Measured on a live worktree container: a ":ro" bind
# reports `ro,nosuid,nodev,relatime` in field 6 while its superblock options
# say `rw` -- so reading the superblock alone reports every read-only parent as
# writable, silently defeating A6. Both are captured; ro on either side wins.
# ---------------------------------------------------------------------------
mc_parse_mountinfo() {
    local file="$1"
    [ -r "$file" ] || return 1
    awk '
        {
            sep = 0
            for (i = 7; i <= NF; i++) { if ($i == "-") { sep = i; break } }
            if (sep == 0) next
            fstype = $(sep + 1)
            source = $(sep + 2)
            superopts = $(sep + 3)
            mode = "rw"
            if ($6 ~ /(^|,)ro(,|$)/) mode = "ro"
            else if (superopts ~ /(^|,)ro(,|$)/) mode = "ro"
            printf "%s\t%s\t%s\t%s\t%s\n", $5, fstype, mode, $4, source
        }
    ' "$file"
}

# ---------------------------------------------------------------------------
# A4 -- binary ABI identity from magic bytes.
#
# Prints one of: ELF | MACHO | FAT | OTHER:<hex> | UNREADABLE
#
# This is the single discriminator that separates a healthy container from the
# measured broken state. On a degraded container the file at
# packages/core/node_modules/better-sqlite3/.../better_sqlite3.node EXISTS and
# is 1 914 736 bytes of perfectly valid Mach-O -- the macOS host's own binary,
# reached by fall-through to the read-only parent. A presence check, an `ls`,
# and `docker inspect` all pass on precisely that state.
# ---------------------------------------------------------------------------
mc_binary_abi() {
    local f="$1" magic
    [ -r "$f" ] || { printf 'UNREADABLE'; return 0; }
    magic="$(od -An -tx1 -N4 -v "$f" 2>/dev/null | tr -d ' \n')"
    case "$magic" in
        7f454c46) printf 'ELF' ;;
        cffaedfe | cefaedfe | feedfacf | feedface) printf 'MACHO' ;;
        cafebabe | bebafeca) printf 'FAT' ;;
        '') printf 'UNREADABLE' ;;
        *) printf 'OTHER:%s' "$magic" ;;
    esac
}

# ---------------------------------------------------------------------------
# A4 (continued) -- ELF machine architecture, so "it is an ELF" cannot stand in
# for "it is an ELF this kernel can actually load".
#
# e_machine is a 2-byte little-endian field at offset 0x12.
# ---------------------------------------------------------------------------
mc_elf_arch() {
    local f="$1" b
    [ -r "$f" ] || { printf 'unreadable'; return 0; }
    b="$(od -An -tx1 -N2 -j18 -v "$f" 2>/dev/null | tr -d ' \n')"
    case "$b" in
        3e00) printf 'x86-64' ;;
        b700) printf 'aarch64' ;;
        0300) printf 'i386' ;;
        2800) printf 'arm' ;;
        '') printf 'unknown' ;;
        *) printf 'machine:0x%s' "$b" ;;
    esac
}

# ---------------------------------------------------------------------------
# A4 (continued) -- is this binary even MEANT for this platform?
#
# Returns 0 ("foreign, do not assert") / 1 ("ours or platform-neutral").
#
# MEASURED 2026-09-11 on `skillsmith-dev-1`: asserting ELF-for-this-arch on
# every *.node under the tree produced 20 findings on a HEALTHY main checkout,
# essentially all of them legitimate multi-platform payloads that ship by
# design -- argon2's prebuildify layout carries darwin-x64, darwin-arm64,
# win32-x64, freebsd-x64, linux-arm and linux-x64 side by side, and napi-rs
# packages ship rvf-node.{darwin-arm64,win32-x64-msvc,linux-x64-gnu}.node in
# one directory. The loader picks the matching one at runtime; the others being
# Mach-O or PE is correct, not a fault.
#
# A detector that fires 20 times on a healthy checkout gets ignored, which is
# precisely the failure mode D-20's warn-only default exists to avoid. So the
# platform is read out of the path (both the prebuildify `prebuilds/<os>-<arch>/`
# and the napi-rs `name.<os>-<arch>-<abi>.node` conventions tokenise the same
# way) and foreign-platform payloads are skipped rather than asserted on.
#
# The genuinely broken case still surfaces: a path that NAMES this platform
# (e.g. attention.linux-arm64-gnu.node) while containing a Mach-O is reported,
# because its own filename claims to be the linux-arm64 build.
# ---------------------------------------------------------------------------
mc_is_foreign_platform_binary() {
    local path="$1" machine="$2"
    local lower tokens t
    lower="$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"
    tokens="$(printf '%s' "$lower" | tr -c 'a-z0-9' ' ')"

    # A non-Linux OS token anywhere in the path settles it immediately.
    for t in $tokens; do
        case "$t" in
            darwin | win32 | windows | msvc | freebsd | openbsd | netbsd | android | sunos | ios)
                return 0
                ;;
        esac
    done

    local ours="" foreign=""
    case "$machine" in
        aarch64) ours="arm64 aarch64 armv8" ;;
        x86-64) ours="x64 x86_64 amd64" ;;
        *) return 1 ;; # unknown kernel: do not guess, assert nothing away
    esac

    # If the path names OUR architecture, it is ours -- assert on it.
    for t in $tokens; do
        case " $ours " in *" $t "*) return 1 ;; esac
    done

    # If it names some OTHER architecture, it is a foreign payload.
    foreign="x64 x86 amd64 ia32 i386 arm armv6 armv7 arm64 aarch64 ppc64 ppc64le s390x riscv64 loong64 mips64 mips64el"
    for t in $tokens; do
        case " $foreign " in *" $t "*) return 0 ;; esac
    done

    # Platform-neutral path (e.g. build/Release/better_sqlite3.node): assert.
    return 1
}

# ---------------------------------------------------------------------------
# A8 -- ownership and the executable bit on a restored native target.
#
# Prints "<uid>:<gid>:<exec|noexec>", or "missing"/"unreadable".
#
# Callers must NOT treat "noexec" as a failure for a `.node` shared object:
# measured, dlopen succeeds on mode 0644 and every .node in a live container is
# 0644. Readability is the real precondition; see the A8 block in
# check-mount-composition.probes.sh for the measurement.
# ---------------------------------------------------------------------------
mc_file_ownership() {
    local f="$1" uid gid x
    [ -e "$f" ] || { printf 'missing'; return 0; }
    [ -r "$f" ] || { printf 'unreadable'; return 0; }
    if stat -c '%u %g' "$f" >/dev/null 2>&1; then
        read -r uid gid <<<"$(stat -c '%u %g' "$f")"
    else
        read -r uid gid <<<"$(stat -f '%u %g' "$f")"
    fi
    if [ -x "$f" ]; then x="exec"; else x="noexec"; fi
    printf '%s:%s:%s' "$uid" "$gid" "$x"
}

# ---------------------------------------------------------------------------
# A4 (continued) -- the package version recorded at seed time, so a stale seed
# of the right ABI is still caught.
# ---------------------------------------------------------------------------
mc_package_version() {
    local pj="$1/package.json"
    [ -r "$pj" ] || { printf 'unknown'; return 0; }
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pj" | head -1 |
        { read -r v || true; printf '%s' "${v:-unknown}"; }
}
