#!/bin/bash
# scripts/lib/repair-worktree-container-symlinks.sh
# SMI-5570/SMI-5074: container-side node_modules symlink repair.
#
# Background: docs/internal/implementation/smi-5570-5074-worktree-native-module-resolution-plan.md
#
# SMI-4381's per-package node_modules symlinks
# (packages/<pkg>/node_modules -> ../../../../packages/<pkg>/node_modules,
# or a shallower ../../../packages/<pkg>/node_modules for the nested
# <repo>/<name>/ layout, SMI-4654) are sized for the HOST's nesting depth
# under the git superproject root. Docker's mount(2) follows symlinks when
# resolving a bind mount's destination, same as open()/stat() — so the
# SMI-5559/5560 override's own per-package node_modules mount, declared at
# that same symlink's location, gets silently misrouted wherever the
# escaping relative target clamps to inside a worktree container's
# shallower /app nesting (confirmed via /proc/self/mountinfo, see the plan
# doc above), instead of landing at /app/packages/<pkg>/node_modules as
# intended. The same escape affects the hoisted workspace alias symlinks
# seeded by `npm ci` at image-build time
# (/node_modules/@skillsmith/<pkg> -> ../../packages/<pkg>), breaking
# cross-package resolution (e.g. mcp-server requiring @skillsmith/core)
# with "Cannot find module" even though the real content exists somewhere
# in the container.
#
# This script repairs both symlink classes by reading each one's ACTUAL
# resolved target (not a hardcoded escape-depth assumption — works
# regardless of which worktree layout produced the original symlink) and
# repointing it at that real location with an absolute path.
#
# SMI-5650 extension: the hoisted-alias branch below now CREATES (not just
# repairs) workspace-alias symlinks. Post-SMI-5626 a worktree container's
# root /node_modules is bind-mounted read-only, so the old repair-only
# path (gated on a link already existing) hit EROFS and couldn't help;
# SMI-5650 layers a writable tmpfs over each npm scope dir
# (/node_modules/@skillsmith, @smith-horn) that starts EMPTY at every boot,
# so this script must seed it. The alias name is derived from each
# package's own package.json "name" field, covering any scope (e.g.
# @smith-horn/enterprise — a pre-existing gap), building on the same
# SMI-5570/SMI-5074 mount(2) symlink-clamping mechanism described above.
#
# Usage: bash scripts/lib/repair-worktree-container-symlinks.sh [packages-dir] [node-modules-dir]
#   packages-dir      default: /app/packages
#   node-modules-dir   default: /node_modules (the hoisted workspace root)
#
# Exit code: always 0 (non-fatal by design — a repair failure logs a
# warning and continues; native/WASM module errors surface later with
# their own actionable messages).

set -u

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PACKAGES_DIR="${1:-/app/packages}"
HOISTED_NODE_MODULES_DIR="${2:-/node_modules}"

repaired_count=0

if [ -d "$PACKAGES_DIR" ]; then
    for pkg_dir in "$PACKAGES_DIR"/*/; do
        [ -d "$pkg_dir" ] || continue
        pkg="$(basename "$pkg_dir")"

        link="$PACKAGES_DIR/$pkg/node_modules"
        if [ -L "$link" ]; then
            # Compare the symlink's literal one-hop target against its fully
            # resolved target. If they're already IDENTICAL, this is already
            # a direct absolute link to real content — nothing to do (this
            # correctly recognizes a PRIOR repair as already-correct, even
            # though the repaired target deliberately sits outside the app
            # root — "resolves under /app" is NOT the right correctness
            # test here, since the real content the escape lands on is, by
            # definition, wherever Docker's mount actually put it). If they
            # differ, the literal target is relative and/or multi-hop (the
            # raw, unrepaired SMI-4381 symlink, or any other indirection) —
            # repoint it directly at the fully resolved target.
            literal_target="$(readlink "$link" 2>/dev/null || true)"
            resolved="$(readlink -f "$link" 2>/dev/null || true)"
            if [ -z "$resolved" ]; then
                echo -e "${YELLOW}[repair] Could not resolve ${link} (non-fatal)${NC}"
            elif [ "$literal_target" != "$resolved" ]; then
                rm -f "$link" 2>/dev/null || true
                if ln -sfn "$resolved" "$link" 2>/dev/null; then
                    repaired_count=$((repaired_count + 1))
                else
                    echo -e "${YELLOW}[repair] Could not repair ${link} -> ${resolved} (non-fatal)${NC}"
                fi
            fi
        fi

        # SMI-5650: hoisted workspace-alias CREATION (not just repair). The
        # scope dirs (/node_modules/@skillsmith, @smith-horn) are per-boot
        # empty writable tmpfs overlays now (see scripts/_lib.sh); derive
        # each package's real npm name from its own package.json instead of
        # assuming @skillsmith/<dir-basename> — fixes the pre-existing gap
        # where @smith-horn/enterprise was never covered. Unscoped aliases
        # (skillsmith-cli, skillsmith-vscode) are individual leaf symlinks
        # directly under the READ-ONLY root mount: unrepairable here and
        # deliberately out of scope (no bare-specifier importers exist,
        # verified SMI-5650 plan §2.2) — skipped with a log line so a future
        # bare import fails loudly with a breadcrumb, not silently.
        pkg_json="$pkg_dir/package.json"
        if [ -f "$pkg_json" ]; then
            pkg_real_name="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" 2>/dev/null | head -1)"
            case "$pkg_real_name" in
            @*/*)
                scope_dir="$HOISTED_NODE_MODULES_DIR/${pkg_real_name%%/*}"
                alias_link="$scope_dir/${pkg_real_name#*/}"
                correct_target="$PACKAGES_DIR/$pkg"
                if [ -d "$scope_dir" ] && [ -w "$scope_dir" ]; then
                    if [ "$(readlink "$alias_link" 2>/dev/null || true)" != "$correct_target" ]; then
                        if ln -sfn "$correct_target" "$alias_link" 2>/dev/null; then
                            repaired_count=$((repaired_count + 1))
                        else
                            echo -e "${YELLOW}[repair] Could not link ${alias_link} -> ${correct_target} (non-fatal). If this persists across restarts, run scripts/repair-worktrees.sh on the host, then recreate this container.${NC}"
                        fi
                    fi
                else
                    echo -e "${YELLOW}[repair] ${scope_dir} missing/read-only — alias ${pkg_real_name} not linked. Likely a stale docker-compose.override.yml (pre-SMI-5650): run scripts/repair-worktrees.sh on the host, then recreate this container.${NC}"
                fi
                ;;
            esac
        fi
    done
fi

if [ "$repaired_count" -gt 0 ]; then
    echo -e "${GREEN}[repair] Repaired ${repaired_count} worktree node_modules symlink(s) (SMI-5570/SMI-5074)${NC}"
else
    echo -e "${GREEN}[repair] Worktree node_modules symlinks already correct (SMI-5570/SMI-5074)${NC}"
fi

exit 0
