#!/usr/bin/env bash
# SMI-4689: Unit tests for enumerate_compose_node_modules_mounts and
# generate_docker_override (the macOS bind-mount block).
#
# Covers:
#   1. enumerate_compose_node_modules_mounts emits one line per package whose
#      <repo>/packages/<pkg>/node_modules exists; skips packages without it.
#   2. Output indentation matches docker-compose YAML expectations (6 spaces).
#   3. Path with spaces in the repo root survives unchanged in the output.
#   4. Empty / missing packages dir → no output.
#   5. generate_docker_override produces an idempotent file with the SMI-4689
#      marker on Darwin, and without it on non-Darwin (uname mock).
#   6. repair_worktrees_compose_override is a no-op on non-Darwin.
#
# SMI-5650 (Wave 1) additions:
#   11. Alias-scope tmpfs entries emitted for BOTH @skillsmith and
#       @smith-horn when both exist as real (non-symlink) directories.
#   12. tmpfs entries SKIPPED when a scope dir is simply missing.
#   13. tmpfs entries SKIPPED when a scope dir is a SYMLINK rather than a
#       real directory (the crash-prevention guard from plan §1.4 — a
#       symlink leaf at the mount destination's final path component must
#       never be mounted over, or the container fails to create).
#   14. Mount-order regression guard (plan-review M1): the root `:ro` mount
#       line must appear BEFORE every alias-scope tmpfs `target:` line in
#       the generated output.
#
# SMI-5650 (Wave 2) additions — REVISED after live verification. Docker
# Compose's `type: tmpfs` volumes hardcode `noexec`, which breaks native
# module loading (execve() for esbuild's spawned CLI binary; dlopen()/
# mmap(PROT_EXEC) for onnxruntime-node's and hnswlib-node's .node addons —
# only better-sqlite3 happened to tolerate it). Native modules therefore do
# NOT use the alias-scopes' `type: tmpfs` shape at all — they get a plain
# Docker-managed named volume (`driver: local`, no driver_opts) instead,
# referenced per-service as a `native-seed-<name>:/app/node_modules/<name>`
# volume-reference line (enumerate_compose_node_modules_mounts) and declared
# once at the top level via enumerate_native_module_volumes. A second
# discovery added `@esbuild` (the whole scope directory, NOT a specific
# platform-arch subpackage) as a 5th NATIVE_MODULES_FOR_OVERLAY entry —
# esbuild's own JS package does not ship the native binary it spawns at
# runtime; that lives in the separate `@esbuild/<platform>-<arch>` package.
# Docker volume names can't contain `@`, so `@esbuild` sanitizes to
# `esbuild-scope` via native_module_volume_name().
#   15. All 5 NATIVE_MODULES_FOR_OVERLAY entries (better-sqlite3,
#       onnxruntime-node, esbuild, hnswlib-node, @esbuild) emit the correct
#       `native-seed-<sanitized-name>:/app/node_modules/<original-name>`
#       volume-reference line when they exist as real (non-symlink)
#       directories — including the @esbuild -> native-seed-esbuild-scope
#       sanitization, tested explicitly as the trickiest case.
#   16. Native-module volume-reference lines SKIPPED when the module dir is
#       simply missing (mirrors test 12's alias-scope pattern).
#   17. Native-module volume-reference lines SKIPPED when the module dir is a
#       SYMLINK (mirrors test 13's crash-prevention guard, proven uniform
#       across all 7 overlay types — 2 alias scopes + 5 native modules —
#       even though native modules no longer use `type: tmpfs`).
#   18. Mount-order regression guard, extended to the full 7-entry list
#       (2 alias scopes + 5 native modules): the root `:ro` mount line must
#       precede EVERY alias-scope tmpfs `target:` line AND EVERY
#       native-module volume-reference line.
#   19. enumerate_native_module_volumes emits correct top-level
#       `native-seed-<sanitized-name>:\n  driver: local` entries — no
#       driver_opts, no tmpfs annotation at all (an ordinary Docker-managed
#       volume, not the alias scopes' tmpfs shorthand) — for each present
#       native module, with the same @esbuild -> esbuild-scope sanitization.
#   20. enumerate_native_module_volumes SKIPS a missing or symlinked
#       module dir, same real-directory guard as the per-service lines.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../_lib.sh
source "$SCRIPT_DIR/_lib.sh"

fail=0
pass=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: expected='$expected' actual='$actual'"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$needle' not in output"
    echo "  Haystack: $haystack"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL $name: '$needle' should NOT be in output"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# -----------------------------------------------------------------------
# Fixture builders
# -----------------------------------------------------------------------
make_repo() {
  local root="$1"
  shift
  mkdir -p "$root/packages"
  for pkg in "$@"; do
    mkdir -p "$root/packages/$pkg/node_modules"
  done
}

# -----------------------------------------------------------------------
# Helper: write a minimal package.json into a fixture package
# -----------------------------------------------------------------------
make_pkg_json() {
  local root="$1" pkg="$2" name="$3"
  cat > "$root/packages/$pkg/package.json" <<EOF
{ "name": "$name", "version": "0.0.0" }
EOF
}

make_workspace_symlink() {
  # Match npm's real-world depth:
  # - Scoped (@x/y):   <root>/node_modules/@x/y -> ../../packages/<pkg>  (2 levels up)
  # - Non-scoped (y):  <root>/node_modules/y    -> ../packages/<pkg>     (1 level up)
  local root="$1" name="$2" pkg="$3"
  mkdir -p "$(dirname "$root/node_modules/$name")"
  case "$name" in
    @*/*) ln -sf "../../packages/$pkg" "$root/node_modules/$name" ;;
    *)    ln -sf "../packages/$pkg"    "$root/node_modules/$name" ;;
  esac
}

# -----------------------------------------------------------------------
# Test 1: 3 packages, each with node_modules + workspace symlink.
# Expected (SMI-5560): 3 per-pkg READ-ONLY lines only. Workspace-sibling
# whole-package mounts were removed (they shadowed the worktree's own source
# with main's and created the same-host-dir double-mount that made :ro trip
# the virtiofs host_mark regression).
# -----------------------------------------------------------------------
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT" "$SPACEROOT" "$EMPTYROOT"' EXIT

make_repo "$TMPROOT" core mcp-server vscode-extension
make_pkg_json "$TMPROOT" core "@skillsmith/core"
make_pkg_json "$TMPROOT" mcp-server "@skillsmith/mcp-server"
make_pkg_json "$TMPROOT" vscode-extension "skillsmith-vscode"
make_workspace_symlink "$TMPROOT" "@skillsmith/core" "core"
make_workspace_symlink "$TMPROOT" "@skillsmith/mcp-server" "mcp-server"
make_workspace_symlink "$TMPROOT" "skillsmith-vscode" "vscode-extension"

OUT=$(enumerate_compose_node_modules_mounts "$TMPROOT")

# make_workspace_symlink's `mkdir -p` creates $TMPROOT/node_modules AND
# $TMPROOT/node_modules/@skillsmith (a real, non-symlink scope dir — only
# the leaf `core`/`mcp-server` under it are symlinks), so the SMI-5626 root
# block fires (3 lines) AND the SMI-5650 @skillsmith alias-scope tmpfs entry
# fires (1 "- type: tmpfs" line; @smith-horn is absent, so it does not):
# 3 per-pkg pkgs * 3 lines (9) + root (:ro + .vite + .vite-temp = 3) +
# @skillsmith tmpfs (1) = 13.
assert_eq "test1: 9 per-pkg lines + 3 root lines + 1 alias tmpfs line = 13" 13 "$(printf '%s\n' "$OUT" | grep -c '^      - ' || true)"
assert_contains "test1: @skillsmith alias-scope tmpfs emitted (real scope dir, SMI-5650)" "        target: /app/node_modules/@skillsmith" "$OUT"
assert_not_contains "test1: @smith-horn alias-scope tmpfs NOT emitted (scope dir absent)" "/app/node_modules/@smith-horn" "$OUT"
assert_contains "test1: root node_modules mounted read-only (SMI-5626)" "      - $TMPROOT/node_modules:/app/node_modules:ro" "$OUT"
assert_contains "test1: per-pkg core is read-only" "      - $TMPROOT/packages/core/node_modules:/app/packages/core/node_modules:ro" "$OUT"
assert_contains "test1: per-pkg mcp-server is read-only" "      - $TMPROOT/packages/mcp-server/node_modules:/app/packages/mcp-server/node_modules:ro" "$OUT"
assert_contains "test1: per-pkg vscode-extension is read-only" "      - $TMPROOT/packages/vscode-extension/node_modules:/app/packages/vscode-extension/node_modules:ro" "$OUT"
assert_contains "test1: core .vite-temp overlay (writable, not :ro)" "      - $TMPROOT/packages/core/node_modules/.vite-temp:/app/packages/core/node_modules/.vite-temp" "$OUT"
assert_not_contains "test1: core .vite-temp overlay is NOT read-only" "$TMPROOT/packages/core/node_modules/.vite-temp:/app/packages/core/node_modules/.vite-temp:ro" "$OUT"
assert_contains "test1: core .vite overlay (writable, not :ro)" "      - $TMPROOT/packages/core/node_modules/.vite:/app/packages/core/node_modules/.vite" "$OUT"
assert_not_contains "test1: NO workspace-sibling @skillsmith/core mount" ":/app/node_modules/@skillsmith/core" "$OUT"
assert_not_contains "test1: NO workspace-sibling @skillsmith/mcp-server mount" ":/app/node_modules/@skillsmith/mcp-server" "$OUT"
assert_not_contains "test1: NO workspace-sibling skillsmith-vscode mount" ":/app/node_modules/skillsmith-vscode" "$OUT"

# -----------------------------------------------------------------------
# Test 2: package without node_modules is skipped (matches SMI-4381 gate).
# -----------------------------------------------------------------------
mkdir -p "$TMPROOT/packages/skillsmith-cli"  # NO node_modules, NO package.json

OUT2=$(enumerate_compose_node_modules_mounts "$TMPROOT")
assert_eq "test2: still 13 lines (skillsmith-cli has no node_modules; root+alias-tmpfs block unchanged)" 13 "$(printf '%s\n' "$OUT2" | grep -c '^      - ' || true)"
assert_not_contains "test2: skillsmith-cli per-pkg not emitted" "skillsmith-cli/node_modules:/app/packages/skillsmith-cli" "$OUT2"

# -----------------------------------------------------------------------
# Test 3: missing packages/ dir → empty output
# -----------------------------------------------------------------------
EMPTYROOT=$(mktemp -d)
OUT3=$(enumerate_compose_node_modules_mounts "$EMPTYROOT")
assert_eq "test3: empty output for missing packages/" "" "$OUT3"

# -----------------------------------------------------------------------
# Test 4: path with spaces preserved verbatim (per-pkg :ro)
# -----------------------------------------------------------------------
# Portable across BSD (macOS) and GNU (Linux/Docker) mktemp: `-t` diverges
# (BSD wants a bare prefix, GNU requires the template to end in XXX), so pass
# a full template path with trailing X's instead — the same idiom _lib.sh
# already uses (repair_worktrees_compose_override's `mktemp "$wt_path/....XXXXXX"`).
SPACEROOT=$(mktemp -d "${TMPDIR:-/tmp}/has space test.XXXXXX")
make_repo "$SPACEROOT" core
make_pkg_json "$SPACEROOT" core "@skillsmith/core"
make_workspace_symlink "$SPACEROOT" "@skillsmith/core" "core"
OUT4=$(enumerate_compose_node_modules_mounts "$SPACEROOT")
assert_contains "test4: per-pkg with spaces is read-only" "$SPACEROOT/packages/core/node_modules:/app/packages/core/node_modules:ro" "$OUT4"
assert_not_contains "test4: no workspace-sibling mount with spaces" ":/app/node_modules/@skillsmith/core" "$OUT4"

# -----------------------------------------------------------------------
# Test 7: workspace-sibling mounts never emitted, even when the host
# workspace symlink is present (SMI-5560 removed them entirely).
# -----------------------------------------------------------------------
NOSYMROOT=$(mktemp -d)
make_repo "$NOSYMROOT" core
make_pkg_json "$NOSYMROOT" core "@skillsmith/core"
make_workspace_symlink "$NOSYMROOT" "@skillsmith/core" "core"
OUT7=$(enumerate_compose_node_modules_mounts "$NOSYMROOT")
# make_workspace_symlink creates $NOSYMROOT/node_modules and its real
# @skillsmith scope dir, so root block fires (3) AND the @skillsmith
# alias-scope tmpfs fires (1): 3 per-pkg core lines + 3 root lines +
# 1 alias tmpfs line = 7. No workspace-sibling mount.
assert_eq "test7: 3 per-pkg + 3 root + 1 alias tmpfs = 7, no workspace-sibling" 7 "$(printf '%s\n' "$OUT7" | grep -c '^      - ' || true)"
assert_not_contains "test7: no workspace mount even when symlink present" "/app/node_modules/@skillsmith/core" "$OUT7"
rm -rf "$NOSYMROOT"

# -----------------------------------------------------------------------
# Test 8 (SMI-5626): ROOT node_modules bind mount emitted READ-ONLY, plus
# writable .vite/.vite-temp overlays, when <root>/node_modules exists.
# Per-package mounts must still be present (regression).
# 1 root :ro + 2 root overlays + 1 per-pkg :ro + 2 per-pkg overlays = 6 lines.
# -----------------------------------------------------------------------
ROOTNM=$(mktemp -d)
make_repo "$ROOTNM" core
make_pkg_json "$ROOTNM" core "@skillsmith/core"
mkdir -p "$ROOTNM/node_modules/.vite"
OUT8=$(enumerate_compose_node_modules_mounts "$ROOTNM")
assert_contains "test8: root node_modules mounted read-only" "      - $ROOTNM/node_modules:/app/node_modules:ro" "$OUT8"
assert_contains "test8: root .vite overlay (writable, not :ro)" "      - $ROOTNM/node_modules/.vite:/app/node_modules/.vite" "$OUT8"
assert_contains "test8: root .vite-temp overlay (writable, not :ro)" "      - $ROOTNM/node_modules/.vite-temp:/app/node_modules/.vite-temp" "$OUT8"
assert_not_contains "test8: root .vite overlay is NOT read-only" "$ROOTNM/node_modules/.vite:/app/node_modules/.vite:ro" "$OUT8"
assert_contains "test8: per-package core still present (regression)" "      - $ROOTNM/packages/core/node_modules:/app/packages/core/node_modules:ro" "$OUT8"
assert_eq "test8: 6 mount lines total (3 root + 3 per-pkg)" 6 "$(printf '%s\n' "$OUT8" | grep -c '^      - ' || true)"
rm -rf "$ROOTNM"

# -----------------------------------------------------------------------
# Test 9 (SMI-5626): no <root>/node_modules dir → no root mount line;
# per-package mounts unaffected (mirrors the [[ -d ]] gating convention).
# -----------------------------------------------------------------------
NOROOTNM=$(mktemp -d)
make_repo "$NOROOTNM" core
make_pkg_json "$NOROOTNM" core "@skillsmith/core"
OUT9=$(enumerate_compose_node_modules_mounts "$NOROOTNM")
assert_not_contains "test9: no root mount when <root>/node_modules absent" ":/app/node_modules:ro" "$OUT9"
assert_contains "test9: per-package core still present" "      - $NOROOTNM/packages/core/node_modules:/app/packages/core/node_modules:ro" "$OUT9"
assert_eq "test9: only 3 per-pkg lines (no root block)" 3 "$(printf '%s\n' "$OUT9" | grep -c '^      - ' || true)"
rm -rf "$NOROOTNM"

# -----------------------------------------------------------------------
# Test 10 (SMI-5626): root mount survives a path with spaces verbatim.
# -----------------------------------------------------------------------
# Portable BSD/GNU mktemp — see SPACEROOT above.
SPACEROOTNM=$(mktemp -d "${TMPDIR:-/tmp}/has space root nm.XXXXXX")
make_repo "$SPACEROOTNM" core
make_pkg_json "$SPACEROOTNM" core "@skillsmith/core"
mkdir -p "$SPACEROOTNM/node_modules"
OUT10=$(enumerate_compose_node_modules_mounts "$SPACEROOTNM")
assert_contains "test10: root mount with spaces preserved" "$SPACEROOTNM/node_modules:/app/node_modules:ro" "$OUT10"
rm -rf "$SPACEROOTNM"

# -----------------------------------------------------------------------
# Test 5: indentation is exactly 6 spaces (compose YAML services.<*>.volumes:)
# -----------------------------------------------------------------------
FIRST_LINE=$(printf '%s\n' "$OUT" | head -n 1)
LEADING_WS=$(printf '%s' "$FIRST_LINE" | sed -n 's/^\( *\).*/\1/p')
assert_eq "test5: 6-space indent" "      " "$LEADING_WS"

# -----------------------------------------------------------------------
# Test 6: generate_docker_override produces SMI-4689 marker on Darwin only
# -----------------------------------------------------------------------
WT_DIR="$TMPROOT/.worktrees/test-wt"
mkdir -p "$WT_DIR"
generate_docker_override "$WT_DIR" "test-branch" "$TMPROOT"
OVERRIDE=$(cat "$WT_DIR/docker-compose.override.yml")

if [ "$(uname)" = "Darwin" ]; then
  assert_contains "test6 (Darwin): SMI-4689/SMI-5560/SMI-5626/SMI-5650 v5 marker present" "# SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5" "$OVERRIDE"
  assert_contains "test6 (Darwin): root node_modules mount injected read-only (SMI-5626)" "$TMPROOT/node_modules:/app/node_modules:ro" "$OVERRIDE"
  assert_contains "test6 (Darwin): core mount injected read-only" "/app/packages/core/node_modules:ro" "$OVERRIDE"
  assert_not_contains "test6 (Darwin): no workspace-sibling whole-package mount" ":/app/node_modules/@skillsmith/core" "$OVERRIDE"
  assert_contains "test6 (Darwin): @skillsmith alias-scope tmpfs injected (SMI-5650)" "target: /app/node_modules/@skillsmith" "$OVERRIDE"
else
  assert_not_contains "test6 (non-Darwin): no SMI-4689/SMI-5560/SMI-5626/SMI-5650 marker" "# SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5" "$OVERRIDE"
  assert_not_contains "test6 (non-Darwin): no bind mount" "/app/packages/core/node_modules" "$OVERRIDE"
  assert_not_contains "test6 (non-Darwin): no alias-scope tmpfs" "target: /app/node_modules/@skillsmith" "$OVERRIDE"
fi

# Always present: container_name and ports
assert_contains "test6: container_name emitted" "container_name: test-branch-dev-1" "$OVERRIDE"
assert_contains "test6: dev port emitted" '3000"   # Main app' "$OVERRIDE"

# -----------------------------------------------------------------------
# Test 11 (SMI-5650 Wave 1): alias-scope tmpfs entries emitted for BOTH
# @skillsmith and @smith-horn when both exist as real (non-symlink)
# directories under node_modules/, with the documented 1MiB tmpfs size.
# -----------------------------------------------------------------------
ALIASROOT=$(mktemp -d)
make_repo "$ALIASROOT" core
make_pkg_json "$ALIASROOT" core "@skillsmith/core"
mkdir -p "$ALIASROOT/node_modules/@skillsmith" "$ALIASROOT/node_modules/@smith-horn"
OUT11=$(enumerate_compose_node_modules_mounts "$ALIASROOT")
assert_contains "test11: @skillsmith tmpfs target emitted" "        target: /app/node_modules/@skillsmith" "$OUT11"
assert_contains "test11: @smith-horn tmpfs target emitted" "        target: /app/node_modules/@smith-horn" "$OUT11"
assert_eq "test11: exactly 2 'type: tmpfs' entries" 2 "$(printf '%s\n' "$OUT11" | grep -c '^      - type: tmpfs' || true)"
# (c) tmpfs entries have the documented 1MiB alias-scope size.
SKILLSMITH_BLOCK=$(printf '%s\n' "$OUT11" | awk '/target: \/app\/node_modules\/@skillsmith$/{f=1} f{print} f&&/size:/{exit}')
assert_contains "test11: @skillsmith tmpfs size is 1048576" "size: 1048576" "$SKILLSMITH_BLOCK"
SMITHHORN_BLOCK=$(printf '%s\n' "$OUT11" | awk '/target: \/app\/node_modules\/@smith-horn$/{f=1} f{print} f&&/size:/{exit}')
assert_contains "test11: @smith-horn tmpfs size is 1048576" "size: 1048576" "$SMITHHORN_BLOCK"
assert_contains "test11: @skillsmith tmpfs type is tmpfs" "      - type: tmpfs" "$OUT11"
rm -rf "$ALIASROOT"

# -----------------------------------------------------------------------
# Test 12 (SMI-5650 Wave 1): tmpfs entries SKIPPED when a scope dir is
# simply missing (fresh clone / pre-install). Fails toward today's known
# breakage, never toward a container-create failure.
# -----------------------------------------------------------------------
MISSINGSCOPEROOT=$(mktemp -d)
make_repo "$MISSINGSCOPEROOT" core
make_pkg_json "$MISSINGSCOPEROOT" core "@skillsmith/core"
mkdir -p "$MISSINGSCOPEROOT/node_modules"   # root exists; no @skillsmith/@smith-horn subdirs
OUT12=$(enumerate_compose_node_modules_mounts "$MISSINGSCOPEROOT")
assert_not_contains "test12: no @skillsmith tmpfs when scope dir missing" "target: /app/node_modules/@skillsmith" "$OUT12"
assert_not_contains "test12: no @smith-horn tmpfs when scope dir missing" "target: /app/node_modules/@smith-horn" "$OUT12"
assert_eq "test12: zero 'type: tmpfs' entries" 0 "$(printf '%s\n' "$OUT12" | grep -c '^      - type: tmpfs' || true)"
rm -rf "$MISSINGSCOPEROOT"

# -----------------------------------------------------------------------
# Test 13 (SMI-5650 Wave 1, crash-prevention guard, plan §1.4): tmpfs
# SKIPPED when a scope dir is a SYMLINK rather than a real directory. A
# prior per-alias mount attempt whose destination's final path component
# was itself a symlink crashed the container ("too many levels of
# symlinks" / OCI runtime create failure) — this guard is what prevents
# reproducing that. A sibling real-directory scope in the SAME fixture
# must still emit normally (control case), proving the guard is
# per-scope-dir, not a global bail-out.
# -----------------------------------------------------------------------
SYMLINKSCOPEROOT=$(mktemp -d)
make_repo "$SYMLINKSCOPEROOT" core
make_pkg_json "$SYMLINKSCOPEROOT" core "@skillsmith/core"
mkdir -p "$SYMLINKSCOPEROOT/node_modules" "$SYMLINKSCOPEROOT/elsewhere"
ln -sfn "$SYMLINKSCOPEROOT/elsewhere" "$SYMLINKSCOPEROOT/node_modules/@skillsmith"
mkdir -p "$SYMLINKSCOPEROOT/node_modules/@smith-horn"   # real dir: control case, should still emit
OUT13=$(enumerate_compose_node_modules_mounts "$SYMLINKSCOPEROOT")
assert_not_contains "test13: no @skillsmith tmpfs when scope dir is a symlink" "target: /app/node_modules/@skillsmith" "$OUT13"
assert_contains "test13: @smith-horn tmpfs still emitted (real dir, control case)" "target: /app/node_modules/@smith-horn" "$OUT13"
assert_eq "test13: exactly 1 'type: tmpfs' entry (symlink scope skipped)" 1 "$(printf '%s\n' "$OUT13" | grep -c '^      - type: tmpfs' || true)"
rm -rf "$SYMLINKSCOPEROOT"

# -----------------------------------------------------------------------
# Test 14 (SMI-5650 plan-review M1, mount-order regression guard): the
# root `:ro` node_modules mount line MUST appear BEFORE every alias-scope
# tmpfs `target:` line in the generated output. Compose applies a
# service's `volumes:` entries in list order, and the tmpfs scope mounts
# only resolve correctly once the root :ro mount has already landed and
# exposed @skillsmith/@smith-horn as real directories to mount over — a
# future reorder of these two blocks would silently reintroduce the
# container-crash risk this plan was written to eliminate.
# -----------------------------------------------------------------------
ORDERROOT=$(mktemp -d)
make_repo "$ORDERROOT" core
make_pkg_json "$ORDERROOT" core "@skillsmith/core"
mkdir -p "$ORDERROOT/node_modules/@skillsmith" "$ORDERROOT/node_modules/@smith-horn"
OUT14=$(enumerate_compose_node_modules_mounts "$ORDERROOT")
ROOT_MOUNT_LINE=$(printf '%s\n' "$OUT14" | grep -n -F "      - $ORDERROOT/node_modules:/app/node_modules:ro" | head -1 | cut -d: -f1) || true
SKILLSMITH_TARGET_LINE=$(printf '%s\n' "$OUT14" | grep -n -F "        target: /app/node_modules/@skillsmith" | head -1 | cut -d: -f1) || true
SMITHHORN_TARGET_LINE=$(printf '%s\n' "$OUT14" | grep -n -F "        target: /app/node_modules/@smith-horn" | head -1 | cut -d: -f1) || true

if [ -n "$ROOT_MOUNT_LINE" ] && [ -n "$SKILLSMITH_TARGET_LINE" ] && [ "$ROOT_MOUNT_LINE" -lt "$SKILLSMITH_TARGET_LINE" ]; then
  echo "PASS test14: root :ro mount (line $ROOT_MOUNT_LINE) precedes @skillsmith tmpfs target (line $SKILLSMITH_TARGET_LINE)"
  pass=$((pass + 1))
else
  echo "FAIL test14: root :ro mount (line $ROOT_MOUNT_LINE) does not precede @skillsmith tmpfs target (line $SKILLSMITH_TARGET_LINE)"
  fail=$((fail + 1))
fi

if [ -n "$ROOT_MOUNT_LINE" ] && [ -n "$SMITHHORN_TARGET_LINE" ] && [ "$ROOT_MOUNT_LINE" -lt "$SMITHHORN_TARGET_LINE" ]; then
  echo "PASS test14: root :ro mount (line $ROOT_MOUNT_LINE) precedes @smith-horn tmpfs target (line $SMITHHORN_TARGET_LINE)"
  pass=$((pass + 1))
else
  echo "FAIL test14: root :ro mount (line $ROOT_MOUNT_LINE) does not precede @smith-horn tmpfs target (line $SMITHHORN_TARGET_LINE)"
  fail=$((fail + 1))
fi
rm -rf "$ORDERROOT"

# -----------------------------------------------------------------------
# Test 15 (SMI-5650 Wave 2, REVISED post-live-verification): all 5
# NATIVE_MODULES_FOR_OVERLAY entries emit a
# `native-seed-<sanitized-name>:/app/node_modules/<original-name>`
# volume-reference line (NOT `type: tmpfs` — see the header note above on
# the noexec discovery) when they exist as real (non-symlink) directories.
# @esbuild is the trickiest case: it sanitizes to `native-seed-esbuild-scope`,
# asserted explicitly here (not just in native_module_volume_name's own
# unit test) so a regression in the emission loop's call to the sanitizer
# is caught too.
# -----------------------------------------------------------------------
NATIVEROOT=$(mktemp -d)
make_repo "$NATIVEROOT" core
make_pkg_json "$NATIVEROOT" core "@skillsmith/core"
mkdir -p "$NATIVEROOT/node_modules/better-sqlite3" \
         "$NATIVEROOT/node_modules/onnxruntime-node" \
         "$NATIVEROOT/node_modules/esbuild" \
         "$NATIVEROOT/node_modules/hnswlib-node" \
         "$NATIVEROOT/node_modules/@esbuild"
OUT15=$(enumerate_compose_node_modules_mounts "$NATIVEROOT")
assert_contains "test15: better-sqlite3 volume-reference line emitted" "      - native-seed-better-sqlite3:/app/node_modules/better-sqlite3" "$OUT15"
assert_contains "test15: onnxruntime-node volume-reference line emitted" "      - native-seed-onnxruntime-node:/app/node_modules/onnxruntime-node" "$OUT15"
assert_contains "test15: esbuild volume-reference line emitted" "      - native-seed-esbuild:/app/node_modules/esbuild" "$OUT15"
assert_contains "test15: hnswlib-node volume-reference line emitted" "      - native-seed-hnswlib-node:/app/node_modules/hnswlib-node" "$OUT15"
assert_contains "test15: @esbuild scope sanitizes to native-seed-esbuild-scope" "      - native-seed-esbuild-scope:/app/node_modules/@esbuild" "$OUT15"
assert_eq "test15: exactly 5 native-seed volume-reference lines" 5 "$(printf '%s\n' "$OUT15" | grep -c '^      - native-seed-' || true)"
assert_not_contains "test15: native modules do NOT emit type: tmpfs (noexec discovery)" "type: tmpfs" "$OUT15"
rm -rf "$NATIVEROOT"

# -----------------------------------------------------------------------
# Test 16 (SMI-5650 Wave 2): native-module volume-reference lines SKIPPED
# when the module dir is simply missing (mirrors test 12's alias-scope
# pattern). Fails toward today's known breakage, never toward a
# container-create failure.
# -----------------------------------------------------------------------
NATIVEMISSINGROOT=$(mktemp -d)
make_repo "$NATIVEMISSINGROOT" core
make_pkg_json "$NATIVEMISSINGROOT" core "@skillsmith/core"
mkdir -p "$NATIVEMISSINGROOT/node_modules"   # root exists; none of the 5 native module dirs present
OUT16=$(enumerate_compose_node_modules_mounts "$NATIVEMISSINGROOT")
assert_not_contains "test16: no better-sqlite3 volume-reference when dir missing" "native-seed-better-sqlite3:" "$OUT16"
assert_not_contains "test16: no onnxruntime-node volume-reference when dir missing" "native-seed-onnxruntime-node:" "$OUT16"
assert_not_contains "test16: no esbuild volume-reference when dir missing" "native-seed-esbuild:" "$OUT16"
assert_not_contains "test16: no hnswlib-node volume-reference when dir missing" "native-seed-hnswlib-node:" "$OUT16"
assert_not_contains "test16: no @esbuild scope volume-reference when dir missing" "native-seed-esbuild-scope:" "$OUT16"
assert_eq "test16: zero native-seed volume-reference lines (all missing)" 0 "$(printf '%s\n' "$OUT16" | grep -c '^      - native-seed-' || true)"
rm -rf "$NATIVEMISSINGROOT"

# -----------------------------------------------------------------------
# Test 17 (SMI-5650 Wave 2, crash-prevention guard, plan §1.4 origin):
# native-module volume-reference lines SKIPPED when the module dir is a
# SYMLINK rather than a real directory — mirrors test 13's alias-scope
# guard, now proven to apply uniformly across all 7 overlay types (2 alias
# scopes + 5 native modules) even though native modules no longer use
# `type: tmpfs`. A sibling real-directory module (hnswlib-node) in the SAME
# fixture must still emit normally (control case), proving the guard is
# per-entry, not a global bail-out.
# -----------------------------------------------------------------------
NATIVESYMROOT=$(mktemp -d)
make_repo "$NATIVESYMROOT" core
make_pkg_json "$NATIVESYMROOT" core "@skillsmith/core"
mkdir -p "$NATIVESYMROOT/node_modules" \
         "$NATIVESYMROOT/elsewhere-better-sqlite3" \
         "$NATIVESYMROOT/elsewhere-onnxruntime-node" \
         "$NATIVESYMROOT/elsewhere-esbuild" \
         "$NATIVESYMROOT/elsewhere-esbuild-scope"
ln -sfn "$NATIVESYMROOT/elsewhere-better-sqlite3" "$NATIVESYMROOT/node_modules/better-sqlite3"
ln -sfn "$NATIVESYMROOT/elsewhere-onnxruntime-node" "$NATIVESYMROOT/node_modules/onnxruntime-node"
ln -sfn "$NATIVESYMROOT/elsewhere-esbuild" "$NATIVESYMROOT/node_modules/esbuild"
ln -sfn "$NATIVESYMROOT/elsewhere-esbuild-scope" "$NATIVESYMROOT/node_modules/@esbuild"
mkdir -p "$NATIVESYMROOT/node_modules/hnswlib-node"   # real dir: control case, should still emit
OUT17=$(enumerate_compose_node_modules_mounts "$NATIVESYMROOT")
assert_not_contains "test17: no better-sqlite3 volume-reference when dir is a symlink" "native-seed-better-sqlite3:" "$OUT17"
assert_not_contains "test17: no onnxruntime-node volume-reference when dir is a symlink" "native-seed-onnxruntime-node:" "$OUT17"
assert_not_contains "test17: no esbuild volume-reference when dir is a symlink" "native-seed-esbuild:/app/node_modules/esbuild" "$OUT17"
assert_not_contains "test17: no @esbuild scope volume-reference when dir is a symlink" "native-seed-esbuild-scope:" "$OUT17"
assert_contains "test17: hnswlib-node volume-reference still emitted (real dir, control case)" "native-seed-hnswlib-node:/app/node_modules/hnswlib-node" "$OUT17"
assert_eq "test17: exactly 1 native-seed volume-reference line (4 symlinked native dirs skipped)" 1 "$(printf '%s\n' "$OUT17" | grep -c '^      - native-seed-' || true)"
rm -rf "$NATIVESYMROOT"

# -----------------------------------------------------------------------
# Test 18 (SMI-5650 Wave 2, mount-order regression guard, plan-review M1
# extended): with all 7 overlay dirs present (2 alias scopes + 5 native
# modules), the root `:ro` mount line must still precede EVERY overlay
# line — both the alias-scope `type: tmpfs` `target:` lines test 14 covers
# AND the native-module `native-seed-<name>:` volume-reference lines.
# Compose applies a service's `volumes:` entries in list order; the tmpfs
# overlays only resolve correctly once the root mount has already landed
# and exposed each alias scope's leaf as a real directory to mount over —
# and the emission loop keeps native-module lines in that same textual
# sequence, so this test also guards against a future reorder that would
# interleave the two overlay kinds unexpectedly.
# -----------------------------------------------------------------------
ORDER7ROOT=$(mktemp -d)
make_repo "$ORDER7ROOT" core
make_pkg_json "$ORDER7ROOT" core "@skillsmith/core"
mkdir -p "$ORDER7ROOT/node_modules/@skillsmith" "$ORDER7ROOT/node_modules/@smith-horn" \
         "$ORDER7ROOT/node_modules/better-sqlite3" "$ORDER7ROOT/node_modules/onnxruntime-node" \
         "$ORDER7ROOT/node_modules/esbuild" "$ORDER7ROOT/node_modules/hnswlib-node" \
         "$ORDER7ROOT/node_modules/@esbuild"
OUT18=$(enumerate_compose_node_modules_mounts "$ORDER7ROOT")
assert_eq "test18: exactly 2 'type: tmpfs' entries (alias scopes only)" 2 "$(printf '%s\n' "$OUT18" | grep -c '^      - type: tmpfs' || true)"
assert_eq "test18: exactly 5 native-seed volume-reference lines" 5 "$(printf '%s\n' "$OUT18" | grep -c '^      - native-seed-' || true)"
ROOT_MOUNT_LINE18=$(printf '%s\n' "$OUT18" | grep -n -F "      - $ORDER7ROOT/node_modules:/app/node_modules:ro" | head -1 | cut -d: -f1) || true
for overlay in @skillsmith @smith-horn; do
  TARGET_LINE18=$(printf '%s\n' "$OUT18" | grep -n -F "        target: /app/node_modules/$overlay" | head -1 | cut -d: -f1) || true
  if [ -n "$ROOT_MOUNT_LINE18" ] && [ -n "$TARGET_LINE18" ] && [ "$ROOT_MOUNT_LINE18" -lt "$TARGET_LINE18" ]; then
    echo "PASS test18: root :ro mount (line $ROOT_MOUNT_LINE18) precedes $overlay tmpfs target (line $TARGET_LINE18)"
    pass=$((pass + 1))
  else
    echo "FAIL test18: root :ro mount (line $ROOT_MOUNT_LINE18) does not precede $overlay tmpfs target (line $TARGET_LINE18)"
    fail=$((fail + 1))
  fi
done
for pair in "better-sqlite3:native-seed-better-sqlite3" "onnxruntime-node:native-seed-onnxruntime-node" "esbuild:native-seed-esbuild" "hnswlib-node:native-seed-hnswlib-node" "@esbuild:native-seed-esbuild-scope"; do
  overlay="${pair%%:*}"
  volname="${pair##*:}"
  TARGET_LINE18=$(printf '%s\n' "$OUT18" | grep -n -F "      - ${volname}:/app/node_modules/${overlay}" | head -1 | cut -d: -f1) || true
  if [ -n "$ROOT_MOUNT_LINE18" ] && [ -n "$TARGET_LINE18" ] && [ "$ROOT_MOUNT_LINE18" -lt "$TARGET_LINE18" ]; then
    echo "PASS test18: root :ro mount (line $ROOT_MOUNT_LINE18) precedes $overlay volume-reference (line $TARGET_LINE18)"
    pass=$((pass + 1))
  else
    echo "FAIL test18: root :ro mount (line $ROOT_MOUNT_LINE18) does not precede $overlay volume-reference (line $TARGET_LINE18)"
    fail=$((fail + 1))
  fi
done
rm -rf "$ORDER7ROOT"

# -----------------------------------------------------------------------
# Test 19 (SMI-5650 Wave 2): enumerate_native_module_volumes emits the
# top-level `native-seed-<sanitized-name>:\n    driver: local` entry — an
# ordinary Docker-managed named volume, NO driver_opts, NO tmpfs annotation
# at all (this is the fix for the noexec discovery, not a tmpfs variant of
# it) — for each present native module, using the same
# native_module_volume_name sanitization as the per-service lines
# (including @esbuild -> native-seed-esbuild-scope).
# -----------------------------------------------------------------------
VOLROOT=$(mktemp -d)
make_repo "$VOLROOT" core
make_pkg_json "$VOLROOT" core "@skillsmith/core"
mkdir -p "$VOLROOT/node_modules/better-sqlite3" \
         "$VOLROOT/node_modules/onnxruntime-node" \
         "$VOLROOT/node_modules/esbuild" \
         "$VOLROOT/node_modules/hnswlib-node" \
         "$VOLROOT/node_modules/@esbuild"
VOLOUT=$(enumerate_native_module_volumes "$VOLROOT")
BSQLITE_VOL_BLOCK=$(printf '%s\n' "$VOLOUT" | grep -A1 -F "  native-seed-better-sqlite3:")
assert_eq "test19: better-sqlite3 volume block is driver: local, no driver_opts" "  native-seed-better-sqlite3:
    driver: local" "$BSQLITE_VOL_BLOCK"
ONNX_VOL_BLOCK=$(printf '%s\n' "$VOLOUT" | grep -A1 -F "  native-seed-onnxruntime-node:")
assert_eq "test19: onnxruntime-node volume block is driver: local, no driver_opts" "  native-seed-onnxruntime-node:
    driver: local" "$ONNX_VOL_BLOCK"
ESBUILD_VOL_BLOCK=$(printf '%s\n' "$VOLOUT" | grep -A1 -F "  native-seed-esbuild:")
assert_eq "test19: esbuild volume block is driver: local, no driver_opts" "  native-seed-esbuild:
    driver: local" "$ESBUILD_VOL_BLOCK"
HNSWLIB_VOL_BLOCK=$(printf '%s\n' "$VOLOUT" | grep -A1 -F "  native-seed-hnswlib-node:")
assert_eq "test19: hnswlib-node volume block is driver: local, no driver_opts" "  native-seed-hnswlib-node:
    driver: local" "$HNSWLIB_VOL_BLOCK"
ESBUILDSCOPE_VOL_BLOCK=$(printf '%s\n' "$VOLOUT" | grep -A1 -F "  native-seed-esbuild-scope:")
assert_eq "test19: @esbuild scope volume block is native-seed-esbuild-scope / driver: local" "  native-seed-esbuild-scope:
    driver: local" "$ESBUILDSCOPE_VOL_BLOCK"
assert_not_contains "test19: no driver_opts anywhere (plain named volume, not tmpfs)" "driver_opts" "$VOLOUT"
assert_not_contains "test19: no tmpfs annotation anywhere" "tmpfs" "$VOLOUT"
assert_eq "test19: exactly 5 declared native-seed volumes" 5 "$(printf '%s\n' "$VOLOUT" | grep -c '^  native-seed-' || true)"
rm -rf "$VOLROOT"

# -----------------------------------------------------------------------
# Test 20 (SMI-5650 Wave 2): enumerate_native_module_volumes SKIPS a
# missing module dir and a symlinked module dir — the same real-directory
# guard gates volume declaration as gates the per-service volume-reference
# lines (tests 16/17's declaration-side counterpart). A sibling
# real-directory module (hnswlib-node) in the same fixture is the control
# case, proving the guard is per-entry.
# -----------------------------------------------------------------------
VOLGUARDROOT=$(mktemp -d)
make_repo "$VOLGUARDROOT" core
make_pkg_json "$VOLGUARDROOT" core "@skillsmith/core"
mkdir -p "$VOLGUARDROOT/node_modules" "$VOLGUARDROOT/elsewhere-esbuild"
ln -sfn "$VOLGUARDROOT/elsewhere-esbuild" "$VOLGUARDROOT/node_modules/esbuild"
mkdir -p "$VOLGUARDROOT/node_modules/hnswlib-node"   # real dir: control case, should still emit
VOLGUARDOUT=$(enumerate_native_module_volumes "$VOLGUARDROOT")
assert_not_contains "test20: no better-sqlite3 volume declared when dir missing" "native-seed-better-sqlite3:" "$VOLGUARDOUT"
assert_not_contains "test20: no esbuild volume declared when dir is a symlink" "native-seed-esbuild:" "$VOLGUARDOUT"
assert_contains "test20: hnswlib-node volume still declared (real dir, control case)" "native-seed-hnswlib-node:" "$VOLGUARDOUT"
assert_eq "test20: exactly 1 declared native-seed volume" 1 "$(printf '%s\n' "$VOLGUARDOUT" | grep -c '^  native-seed-' || true)"
rm -rf "$VOLGUARDROOT"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
