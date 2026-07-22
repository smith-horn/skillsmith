#!/usr/bin/env bash
#
# docker-entrypoint-native-per-package.sh — PER-PACKAGE native-module volume
# seeding + validation for docker-entrypoint.sh (SMI-5784).
#
# Split out of docker-entrypoint.sh per CLAUDE.md's 500-line file-length
# convention (docker-entrypoint.sh grew from 310 to 510 lines adding this
# logic — new debt from this PR, not pre-existing, so a real split rather
# than an ignore-list grandfather entry). Sourced only, never run standalone
# — relies on docker-entrypoint.sh's globals (RED, GREEN, YELLOW, NC),
# already in scope via bash's shared-process sourcing model regardless of
# which file defines them.
#
# Defines three functions, called from docker-entrypoint.sh at the exact
# points this logic used to run inline (pure mechanical extraction — no
# behavior change):
#   seed_per_package_native_modules_boot()             — boot-time seed step
#   validate_native_module()                           — SHARED: also called
#     by docker-entrypoint.sh's own root-only NATIVE_MODULES validation loop,
#     not just the per-package logic in this file. docker-entrypoint.sh
#     sources this file near the top (right after its `set -e` preamble,
#     mirroring scripts/rebase-worktree.sh's own source-its-helpers-early
#     convention) so this function is available wherever either the root
#     loop or validate_and_rebuild_per_package_native_modules() below calls
#     it.
#   validate_and_rebuild_per_package_native_modules()   — validate+rebuild
#
# Companion to docker-entrypoint.sh's root-only native-module seeding
# (SMI-5650): extends the SAME boot-time-seed + validate/rebuild mechanism
# to workspace-local, non-hoisted per-package node_modules copies (e.g.
# packages/core/node_modules/better-sqlite3, pinned independently of root
# per SMI-4484 — a structural, permanent divergence, not incidental drift).
#
# Reference: docs/internal/implementation/smi-5784-native-seed-per-package-volumes.md

# ---------------------------------------------------------------------------
# SMI-5784: seed writable PER-PACKAGE native-module named volumes (worktree
# only). Companion to the root-only loop above: workspace-local, non-hoisted
# copies (e.g. packages/core/node_modules/better-sqlite3, pinned
# independently of root per SMI-4484 — a structural, permanent divergence,
# not incidental drift) get their OWN writable named volume
# (native-seed-<pkg>-<module>, scripts/_lib.sh's
# enumerate_native_module_volumes/enumerate_compose_node_modules_mounts)
# that needs the SAME boot-time seed treatment, from the Dockerfile's
# per-package stash (/opt/native-seed/<pkg>-<module>). Same disable-var gate
# as the root loop above — call-site parity between root and per-package is
# enforced by a dedicated test
# (scripts/tests/docker-entrypoint-native-rebuild-smi5784.test.ts).
#
# Packages without a diverging per-package copy never get a target directory
# at all — scripts/_lib.sh only mounts a native-seed volume there when the
# real-directory guard matched at override-generation time — so
# `[ -d "$target" ]` is false and the pair is skipped with no warning noise.
# This keeps the common (no-divergence) case a true no-op, mirroring the
# no-divergence guarantee enumerate-compose-mounts-smi5784.test.sh proves for
# the mount-generation side.
# ---------------------------------------------------------------------------
seed_per_package_native_modules_boot() {
    if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ]; then
        for pkg_dir in /app/packages/*/; do
            [ -d "$pkg_dir" ] || continue
            pkg="$(basename "$pkg_dir")"
            for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node @esbuild; do
                target="/app/packages/${pkg}/node_modules/${module}"
                # Code-review fix: real-directory guard, parity with
                # scripts/_lib.sh's enumerate_native_module_volumes /
                # enumerate_compose_node_modules_mounts (`-d && ! -L`). If
                # $target is a directory SYMLINK rather than a real directory,
                # treat it exactly like "not found" — skip entirely, same as the
                # no-target case above. Without this guard a symlinked module
                # dir could be wrongly treated as a real per-package overlay
                # target; validation would then fail (resolved path outside the
                # expected package-local prefix) and the failure-recovery
                # `rm -rf "${target:?}"/*` in the validate/rebuild loop below
                # would delete THROUGH the symlink into whatever it points at —
                # a data-loss risk, not cosmetic.
                [ -d "$target" ] && [ ! -L "$target" ] || continue
                seed="/opt/native-seed/${pkg}-${module}"
                already_seeded=1
                case "$module" in
                @*) [ -n "$(ls -A "$target" 2>/dev/null)" ] && already_seeded=0 ;;
                *) [ -f "$target/package.json" ] && already_seeded=0 ;;
                esac
                if [ ! -d "$seed" ]; then
                    echo -e "${YELLOW}[entrypoint] No native seed for ${pkg}/${module} — image predates SMI-5784 (or this pkg/module pair has never diverged from root); falling back to npm rebuild if validation fails.${NC}"
                elif [ "$already_seeded" -eq 1 ]; then
                    if cp -a "$seed/." "$target/" 2>/dev/null; then
                        echo -e "${GREEN}  ✓ Seeded ${pkg}/${module} into writable overlay (SMI-5784)${NC}"
                    else
                        echo -e "${YELLOW}[entrypoint] Could not seed ${pkg}/${module} — the named volume mount is likely missing (stale override, pre-SMI-5784). Run scripts/repair-worktrees.sh on host, recreate container.${NC}"
                    fi
                fi
            done
        done
    fi
}

# SMI-5650: a bare `require('<module>')` is not a sufficient validation check
# for every module — confirmed live while verifying this exact self-heal
# path: better-sqlite3 only dlopen()s its .node binary lazily, on `new
# Database(...)`, not at require() time, and esbuild's JS wrapper only spawns
# its binary on an actual transform/build call, not at require() time either.
# A corrupted binary for either module passed the old bare-require check as a
# false green, which meant the VALIDATION_FAILED rebuild/re-seed path never
# triggered — silently leaving a broken binary in place across restarts.
# onnxruntime-node and hnswlib-node dlopen() immediately at require() time
# (confirmed live: both throw synchronously on a corrupted binary), so a bare
# require() is already sufficient for those two.
validate_native_module() {
    # SMI-5784: path-aware extension. When called with a SECOND argument (a
    # package-local node_modules directory, e.g.
    # /app/packages/core/node_modules), this validates THAT package's own
    # copy — CRITICAL, empirically-confirmed correction (plan-review
    # Blocker #2): the originally-proposed relative
    # `(cd "$path" && node -e "require('$module')...")` check is unsafe —
    # reproduced live: emptying the package-local copy and running that
    # exact probe still resolved successfully, to a DIFFERENT, older copy
    # elsewhere on the filesystem (Node's resolution algorithm walks up past
    # the empty/broken local directory). A relative require() can therefore
    # never prove the intended target loaded.
    #
    # Fix: resolve via require.resolve() with an explicit `paths` array
    # pinned to the package's OWN node_modules, then assert the resolved
    # absolute path is PREFIXED by that exact package-local module
    # directory before loading anything. A resolution that succeeds but
    # points OUTSIDE that prefix is a validation FAILURE, never a silent
    # pass — silently falling back to a stale/wrong-version copy is worse
    # than an honest error. @esbuild (a scope, not an installed package —
    # `require.resolve('@esbuild', ...)` has no main entry to resolve) is
    # probed via its co-located flat `esbuild` sibling instead, same
    # esbuild/@esbuild coupling the case dispatch below uses for the
    # root-only path.
    #
    # REALPATH FIX (empirically found live against a real worktree
    # container, distinct from Blocker #2): require.resolve() always
    # returns a REALPATH-canonicalized absolute path (Node's CommonJS
    # resolver calls fs.realpathSync internally), but $2 here is the
    # worktree's nominal /app/packages/<pkg>/node_modules path, which the
    # SMI-5570/SMI-5074 mount(2) symlink-clamping mechanism (documented at
    # length in scripts/_lib.sh's enumerate_compose_node_modules_mounts)
    # can land at a DIFFERENT real kernel path (e.g. /packages/<pkg>/node_modules,
    # outside /app). Comparing require.resolve()'s canonicalized return
    # value against a non-canonicalized $2-derived prefix produced a FALSE
    # NEGATIVE — a genuinely correct resolution rejected as a validation
    # failure — confirmed live via a real container's `mount | grep` output
    # and a manual repro of this exact check. Canonicalizing $2 through
    # fs.realpathSync() before building the expected prefix (falling back
    # to the literal path if realpathSync itself throws, e.g. a dangling
    # symlink) makes both sides of the comparison agree on the same
    # notion of "real" location, without weakening the Blocker #2
    # protection: a genuine climb to an unrelated directory (e.g. root's
    # node_modules) still fails the prefix check either way, since its
    # realpath is never a prefix of the package-local realpath.
    if [ -n "${2:-}" ]; then
        local probe="$1"
        case "$1" in
        @*) probe="esbuild" ;;
        esac
        node -e "const p=require('path');const fs=require('fs');let base='$2';try{base=fs.realpathSync('$2')}catch(e){}let r;try{r=require.resolve('$probe',{paths:['$2']})}catch(e){process.exit(1)}if(!r.startsWith(p.join(base,'$probe')+p.sep)){process.exit(1)}try{if('$probe'==='better-sqlite3'){new (require(r))(':memory:').close()}else if('$probe'==='esbuild'){require(r).transformSync('1')}else{require(r)}}catch(e){process.exit(1)}" 2>/dev/null
        return $?
    fi

    case "$1" in
    better-sqlite3)
        node -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null
        ;;
    esbuild | @esbuild)
        # Same check for both entries: esbuild's JS API spawns the actual
        # native binary that lives in the separate @esbuild/<platform>-<arch>
        # scope package, so transformSync() exercises both. @esbuild is
        # listed as its own NATIVE_MODULES entry purely so the rebuild/re-seed
        # loop re-seeds its content too — see the boot-time seed step's
        # comment above for why the scope, not just the flat `esbuild`
        # package, needs its own writable target.
        node -e "require('esbuild').transformSync('1')" 2>/dev/null
        ;;
    *)
        node -e "require('$1')" 2>/dev/null
        ;;
    esac
}

# ---------------------------------------------------------------------------
# SMI-5784: validate + self-heal PER-PACKAGE native-module overlays
# (worktree-only — the entire native-seed-<pkg>-<module> mechanism only
# exists in worktree containers; the main checkout's skillsmith-dev-1
# container never runs under this bind-mount topology at all, plan §2 point
# 5). Independent of the root VALIDATION_FAILED flag above: a package-local
# copy can be broken even when every ROOT copy validates cleanly (and vice
# versa), so each (package, module) target tracks its OWN pass/fail — a
# failure in one package's copy must never trigger a rebuild of another,
# already-healthy package's copy (plan-review Blocker #2's companion gating
# fix). This is deliberately a SIBLING section to the VALIDATION_FAILED
# block above, not nested inside it: nesting inside `if [ $VALIDATION_FAILED
# -eq 1 ]` would skip per-package validation entirely whenever every ROOT
# module happens to validate cleanly, which is exactly the failure mode this
# section exists to catch.
# ---------------------------------------------------------------------------
validate_and_rebuild_per_package_native_modules() {
    if [ -f "/app/.git" ]; then
        echo -e "${YELLOW}[entrypoint] Validating per-package native module overlays...${NC}"
        PACKAGE_TARGETS_FAILED=""

        for pkg_dir in /app/packages/*/; do
            [ -d "$pkg_dir" ] || continue
            pkg="$(basename "$pkg_dir")"
            pkg_node_modules="/app/packages/${pkg}/node_modules"

            for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node @esbuild; do
                target="${pkg_node_modules}/${module}"
                # Code-review fix: same real-directory guard as the boot-time
                # seed loop above (`-d && ! -L`, parity with scripts/_lib.sh's
                # enumerate_native_module_volumes / enumerate_compose_node_modules_mounts)
                # — a symlinked module dir is skipped entirely here too, so the
                # `rm -rf "${target:?}"/*` re-seed/rebuild recovery a few lines
                # below can never run through a symlink.
                [ -d "$target" ] && [ ! -L "$target" ] || continue

                if validate_native_module "$module" "$pkg_node_modules"; then
                    echo -e "${GREEN}  ✓ ${pkg}/${module}${NC}"
                    continue
                fi
                echo -e "${RED}  ✗ ${pkg}/${module} - validation failed${NC}"

                # SMI-5784 (worktree): re-seed from the image stash first —
                # deterministic and offline, same SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE
                # gate as the boot-time per-package seed step and root's own
                # reseed fast path above (parity requirement, plan §2 point 4 —
                # both root and per-package call-sites must honor the disable
                # var identically).
                seed="/opt/native-seed/${pkg}-${module}"
                if [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ] && [ -d "$seed" ]; then
                    rm -rf "${target:?}"/* 2>/dev/null || true
                    cp -a "$seed/." "$target/" 2>/dev/null || true
                    if validate_native_module "$module" "$pkg_node_modules"; then
                        echo -e "${GREEN}  ✓ ${pkg}/${module} restored from image seed (SMI-5784)${NC}"
                        continue
                    fi
                fi

                echo -e "${YELLOW}  Rebuilding ${pkg}/${module} (scoped to package, first run may fetch a prebuilt)...${NC}"
                # Scoped to the package directory (cd first) so npm resolves and
                # rebuilds against THAT package's own pinned version, not root's
                # — this is the whole reason the rebuild is per-target rather
                # than a single global npm rebuild call.
                (cd "$pkg_dir" && npm rebuild "${module}" --ignore-scripts=false) \
                    || echo -e "${YELLOW}  ↳ npm rebuild exited non-zero for ${pkg}/${module} (see output above)${NC}"

                if validate_native_module "$module" "$pkg_node_modules"; then
                    echo -e "${GREEN}  ✓ ${pkg}/${module} rebuilt successfully${NC}"
                else
                    echo -e "${RED}  ✗ ${pkg}/${module} - still failing after rebuild${NC}"
                    # Per-target failure tracking (NOT a single global flag): a
                    # failure here must never trigger a rebuild of any OTHER
                    # package's already-healthy copy — each (pkg, module) pair
                    # above is independently seeded/rebuilt/re-validated.
                    PACKAGE_TARGETS_FAILED="${PACKAGE_TARGETS_FAILED:+$PACKAGE_TARGETS_FAILED }${pkg}/${module}"
                fi
            done
        done

        if [ -n "$PACKAGE_TARGETS_FAILED" ]; then
            echo -e "${RED}[entrypoint] Per-package native module validation failed after rebuild: ${PACKAGE_TARGETS_FAILED}${NC}"
            echo -e "${YELLOW}For verbose rebuild output (run on host, per target): docker exec <container> sh -c 'cd /app/packages/<pkg> && npm rebuild <module> --ignore-scripts=false'${NC}"
            exit 1
        fi

        echo -e "${GREEN}[entrypoint] All per-package native module overlays validated.${NC}"
    fi
}
