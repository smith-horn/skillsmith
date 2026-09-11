#!/usr/bin/env bash
#
# check-mount-composition.probes.sh — live filesystem probes for A4-A8.
#
# Sourced by check-mount-composition.sh only when --live is given. Split out
# for the 500-line pre-commit gate. Every probe here PREFERS A DIRECT TEST OF
# THE PROPERTY over an inference from metadata: a mount flag is an inference;
# a write that actually succeeds or actually returns EROFS is a measurement.
# That distinction is the whole reason this fault went undetected -- container
# metadata reported RW=true for a destination that was not mounted at all.
#
# Every probe writes through the DECLARED (traversal) path, never the resolved
# one. M-6 reproduces the EROFS only through the traversal path; probing the
# resolved path can succeed while the path real consumers use fails.
#
# shellcheck shell=bash
# shellcheck disable=SC2154  # fail/okline/note + MC_* come from the caller

mc_probe_tag() { printf '.mc-probe.%s.%s' "$$" "${RANDOM:-0}"; }

# ---------------------------------------------------------------------------
# A4 + A8 -- per-copy ABI identity, architecture, seeded version, ownership and
# the executable bit, for every mounted native target.
#
# Presence is NOT the assertion. On the measured broken state the file exists,
# is readable, is 1 914 736 bytes, and is a perfectly valid Mach-O -- the macOS
# host's own binary, reached by fall-through to the read-only parent. Only the
# ABI discriminates. Architecture and version are checked too, so that "it is
# an ELF" cannot stand in for "it is an ELF this kernel can load", and a stale
# seed of the right ABI is still caught.
# ---------------------------------------------------------------------------
mc_probe_abi() {
    local tmp="$1" scanned=0 bad=0 skipped=0 machine
    # A single binary can sit under more than one declared destination (on the
    # main checkout /app and /app/node_modules both cover the root tree), which
    # would otherwise report the same fault once per covering declaration.
    # Dedupe by absolute file path so a finding count means "distinct broken
    # binaries", not "declaration x binary pairs".
    : >"$tmp/abi.seen"
    machine="$(uname -m 2>/dev/null || echo unknown)"
    case "$machine" in
        aarch64 | arm64) machine="aarch64" ;;
        x86_64 | amd64) machine="x86-64" ;;
    esac

    while IFS=$'\t' read -r res dst src _opts; do
        # Named-volume destinations are the seeded native targets. A bind
        # source contains a "/"; a volume name does not.
        case "$src" in */*) continue ;; esac
        [ -d "$dst" ] || continue

        # DO NOT skip unmounted destinations. That was a real defect in an
        # earlier revision of this probe and it skipped the PRIMARY signature:
        # the canonical fall-through (M-3b) is a destination that is NOT
        # mounted, whose path therefore resolves through to the read-only
        # parent and serves the host's Mach-O. Verified live 2026-09-11:
        #   /app/packages/core/node_modules/better-sqlite3/.../better_sqlite3.node
        #     -> cf fa ed fe (Mach-O, 1 914 736 B), destination NOT in mountinfo
        #   /node_modules/better-sqlite3/.../better_sqlite3.node
        #     -> 7f 45 4c 46 (ELF), destination mounted
        # Mount state is what distinguishes the two root causes, so it is
        # recorded and reported rather than used to skip.
        local mounted=0
        grep -qxF "$res" "$tmp/actual.set" && mounted=1

        local found=0 nodefile abi arch own ver cause
        if [ "$mounted" = 1 ]; then
            cause="destination IS mounted, so the SEEDED VOLUME CONTENT itself is wrong (not a fall-through)"
        else
            cause="destination is NOT mounted -- READ-ONLY-PARENT FALL-THROUGH: the host's macOS binary is being served at a Linux path (SMI-6516 signature)"
        fi
        ver="$(mc_package_version "$dst")"
        while IFS= read -r nodefile; do
            [ -n "$nodefile" ] || continue
            found=1
            # Multi-platform prebuild bundles ship foreign binaries ON PURPOSE.
            # Skipping them is required for the detector to be usable at all --
            # see mc_is_foreign_platform_binary's header for the measurement.
            # They are excluded from the denominator too, so the reported
            # "scanned N" is the number actually ASSERTED on, not the number
            # walked past.
            if mc_is_foreign_platform_binary "$nodefile" "$machine"; then
                skipped=$((skipped + 1))
                continue
            fi
            grep -qxF "$nodefile" "$tmp/abi.seen" && continue
            printf '%s\n' "$nodefile" >>"$tmp/abi.seen"
            scanned=$((scanned + 1))
            abi="$(mc_binary_abi "$nodefile")"
            own="$(mc_file_ownership "$nodefile")"
            if [ "$abi" != "ELF" ]; then
                bad=$((bad + 1))
                fail A4 "$nodefile is $abi, expected ELF (declared $dst, volume=$src, version=$ver) -- $cause"
                continue
            fi
            arch="$(mc_elf_arch "$nodefile")"
            if [ "$machine" != "unknown" ] && [ "$arch" != "$machine" ]; then
                bad=$((bad + 1))
                fail A4 "$nodefile is ELF/$arch but this kernel is $machine (declared $dst, version=$ver)"
            fi
            # A8 -- ownership and the permission bit that ACTUALLY gates loading.
            #
            # MEASURED 2026-09-11, and it overturns the obvious reading of A8:
            # `dlopen` does NOT require the execute bit. Every one of the 36
            # `.node` files in a live container is mode 0644, including ones
            # demonstrably in use, and `process.dlopen()` on a 0644 file
            # SUCCEEDS. Asserting +x on a `.node` therefore flags 27 of 28
            # healthy binaries -- a detector that fires on every worktree at
            # once is worse than no detector.
            #
            # What a shared object actually needs is READABILITY. The exec bit
            # is asserted only for real executables under a bin/ directory.
            case "$own" in
                missing | unreadable)
                    bad=$((bad + 1))
                    fail A8 "$nodefile is $own (declared $dst) -- a native module that cannot be read cannot be dlopen'd"
                    ;;
            esac
            case "$nodefile" in
                */bin/*)
                    case "$own" in
                        *:noexec)
                            bad=$((bad + 1))
                            fail A8 "$nodefile lives under bin/ but is not executable (owner:group:bit = $own)"
                            ;;
                    esac
                    ;;
            esac
            # -H so a declared destination that is ITSELF a symlink is still
            # descended; without it `find` stops at the link and silently
            # scans nothing, which reads exactly like a clean result.
        done < <(find -H "$dst" -maxdepth 4 -type f -name '*.node' 2>/dev/null)

        if [ "$found" = 0 ] && [ "$ver" != "unknown" ]; then
            : # a seeded package with no .node payload is legitimate (pure JS)
        fi
    done <"$tmp/expected.uniq.tsv"

    # ALWAYS report the denominator, pass or fail. A findings-only summary makes
    # a scope-blind run ("scanned 0 files, no findings") read identically to a
    # real clean one -- the same invisible-success shape this checker exists to
    # eliminate.
    okline A4 "asserted on $scanned native binary/binaries for $machine across declared native targets (mounted AND unmounted); $bad failed; $skipped skipped as foreign-platform payloads"
}

# ---------------------------------------------------------------------------
# A5 -- per-package traversal-path writability, for EVERY declared writable
# overlay, PER PACKAGE.
#
# Not one global probe. A single `@skillsmith/core` database open validates one
# copy of one module and would pass while seven other packages are broken --
# measured: on a degraded worktree ALL 24 per-package cache overlays detach
# uniformly across all 8 packages, and the EROFS reproduces only through the
# traversal path a real consumer uses.
# ---------------------------------------------------------------------------
mc_probe_writability() {
    local tmp="$1" probed=0 bad=0 tag
    tag="$(mc_probe_tag)"
    while IFS=$'\t' read -r _res dst _src opts; do
        case ",$opts," in *,ro,*) continue ;; esac
        case "$dst" in */node_modules/*) ;; *) continue ;; esac
        probed=$((probed + 1))
        if [ ! -d "$dst" ]; then
            bad=$((bad + 1))
            fail A5 "declared writable overlay is not a directory: $dst"
            continue
        fi
        if : >"$dst/$tag" 2>/dev/null; then
            rm -f "$dst/$tag" 2>/dev/null || true
        else
            bad=$((bad + 1))
            fail A5 "NOT WRITABLE through the traversal path: $dst/ (EROFS or permission) -- this is SMI-6520's symptom"
        fi
    done <"$tmp/expected.uniq.tsv"
    okline A5 "probed $probed declared writable overlay(s) through their traversal path; $bad not writable"
}

# ---------------------------------------------------------------------------
# A6 (write half) -- the read-only parent must actually REFUSE a write.
#
# The mount flag is checked by the caller; this is the direct test. If this
# probe SUCCEEDS that is the critical finding, not a pass: a writable parent
# means a worktree write can reach the MAIN checkout's real dependency tree --
# exactly the cross-checkout corruption (SMI-5560) the :ro exists to prevent.
# The probe creates a uniquely-named directory and removes it immediately.
# ---------------------------------------------------------------------------
mc_probe_ro_parent_write() {
    local tmp="$1" probed=0 bad=0 tag
    tag="$(mc_probe_tag).d"
    while IFS=$'\t' read -r _res dst _src opts; do
        case ",$opts," in *,ro,*) ;; *) continue ;; esac
        [ -d "$dst" ] || continue
        probed=$((probed + 1))
        if mkdir "$dst/$tag" 2>/dev/null; then
            rmdir "$dst/$tag" 2>/dev/null || true
            bad=$((bad + 1))
            fail A6 "declared :ro parent ACCEPTED A WRITE: $dst -- a write here can reach the main checkout's real dependency tree (SMI-5560)"
        fi
    done <"$tmp/expected.uniq.tsv"
    okline A6 "write-probed $probed declared :ro parent(s); $bad wrongly accepted a write"
}

# ---------------------------------------------------------------------------
# A7 -- undeclared cache directories are REPORTED, never silently treated as
# expected-writable.
#
# The SMI-5722 `.astro` case is the precedent: a newly-introduced cache dir
# under a node_modules with no declared overlay is invisible until the day it
# fails. Anything dot-prefixed directly under a node_modules parent that is not
# in the declared destination set is surfaced here.
# ---------------------------------------------------------------------------
# Dot-directories that legitimately live INSIDE an installed dependency tree
# and are never written to at build time. These are installed content shipped
# by npm itself, not build caches, so flagging them is pure noise.
#
# The list is a DENY-list on purpose, not an allow-list of known cache names:
# A7 exists to catch a cache directory nobody has thought of yet (the SMI-5722
# `.astro` case was exactly that), so anything not explicitly known-benign is
# still reported. Extend via MC_A7_IGNORE (space-separated) rather than by
# widening the match.
MC_A7_IGNORE_DEFAULT=".bin .package-lock.json .yarn-integrity .modules.yaml .store .cache-loader .git"

mc_probe_undeclared_caches() {
    local tmp="$1" reported=0 scanned=0 parents=0 parent child base ign
    ign=" ${MC_A7_IGNORE:-$MC_A7_IGNORE_DEFAULT} "
    cut -f2 "$tmp/expected.uniq.tsv" | sort -u >"$tmp/declared.paths"
    while IFS=$'\t' read -r _res dst _src opts; do
        case ",$opts," in *,ro,*) ;; *) continue ;; esac
        case "$dst" in */node_modules) ;; *) continue ;; esac
        parent="$dst"
        [ -d "$parent" ] || continue
        parents=$((parents + 1))
        for child in "$parent"/.*; do
            [ -d "$child" ] || continue
            base="$(basename "$child")"
            case "$base" in . | ..) continue ;; esac
            scanned=$((scanned + 1))
            case "$ign" in *" $base "*) continue ;; esac
            if ! grep -qxF "$child" "$tmp/declared.paths"; then
                reported=$((reported + 1))
                fail A7 "undeclared cache directory under a read-only parent: $child (no declared writable overlay; the SMI-5722 .astro shape)"
            fi
        done
    done <"$tmp/expected.uniq.tsv"
    okline A7 "scanned $scanned dot-directory/ies under $parents declared read-only parent(s); $reported undeclared"
}

# ---------------------------------------------------------------------------
# Probe tiers.
#
# READ-ONLY tier (A4, A7, A8) inspects only; it is safe to run against any
# container, including one another session is actively using.
#
# WRITE tier (A5, A6-write) creates and immediately removes a uniquely-named
# probe file/dir. It is the only tier that can perturb a live workspace, and
# A6's probe in particular would, if the :ro parent were genuinely writable,
# briefly create a directory in the MAIN checkout's real dependency tree. It is
# therefore opt-in via --live-write rather than bundled into --live.
# ---------------------------------------------------------------------------
mc_run_live_probes() {
    local tmp="$1" with_write="${2:-0}"
    mc_probe_abi "$tmp"
    mc_probe_undeclared_caches "$tmp"
    if [ "$with_write" = 1 ]; then
        mc_probe_writability "$tmp"
        mc_probe_ro_parent_write "$tmp"
    else
        okline A5 "write probes skipped (--live-write not set); A5/A6-write NOT evaluated"
    fi
}
