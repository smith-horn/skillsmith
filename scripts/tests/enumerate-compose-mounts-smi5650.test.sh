#!/usr/bin/env bash
# SMI-5650 (Wave 1 + Wave 2) extension of enumerate-compose-mounts.test.sh
# (split into its own file per CLAUDE.md's 500-line guidance — see the
# sibling file's header for the original SMI-4689/SMI-5560/SMI-5626 tests
# and shared fixture-builder documentation).
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
#
# SMI-6050 (Wave 3) additions — Tier-B (build-tool / compiler platform
# binaries: turbo, Rollup/Rolldown, Astro's compiler, Lightning CSS,
# Tailwind Oxide, ruvector, workerd, ...). UNLIKE every Tier-A test above,
# these gate on a FIXTURE package-lock.json's `os` field via
# scripts/lib/linux-optional-packages.mjs — never on
# `[[ -d "$repo_root/node_modules/<x>" ]]` — because npm never creates a
# Tier-B package's directory at all on a non-matching host platform. Every
# fixture below deliberately has ZERO matching node_modules/ directories on
# disk, proving these lines are emitted from the lockfile-derived list, not
# from host directory existence (the exact regression this wave must avoid
# reintroducing — see the plan doc's "Why the SMI-5650 mechanism can't just
# be extended with more names" section).
#   21. Tier-B volume-reference lines (enumerate_compose_node_modules_mounts)
#       and top-level volume declarations (enumerate_native_module_volumes)
#       are emitted for a root-level and a nested-under-a-dependency
#       fixture entry, with ZERO corresponding host directories present.
#   22. The root-level and nested-under-a-dependency entries for the SAME
#       package family (@rolldown/binding-linux-arm64-gnu, at two different
#       nesting depths) sanitize to two DISTINCT volume names — proving no
#       collision (plan doc "What Changes" #3).
#   23. A non-linux (darwin) fixture entry is NOT emitted (mirrors the
#       derivation script's own `os` filter).
#   24. Tier-B lines disappear entirely under SKILLSMITH_TIER_B_SEED_DISABLE=1,
#       in BOTH enumerate_compose_node_modules_mounts and
#       enumerate_native_module_volumes — the rollback control.
#   25. Tier-B volume declarations use the same driver: local / no
#       driver_opts / SMI-5750 ownership-label shape as Tier-A (no tmpfs).

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
# Fixture builders (mirrors the sibling file's — kept local since shell
# tests have no import mechanism to share them cleanly across files).
# -----------------------------------------------------------------------
make_repo() {
  local root="$1"
  shift
  mkdir -p "$root/packages"
  for pkg in "$@"; do
    mkdir -p "$root/packages/$pkg/node_modules"
  done
}

make_pkg_json() {
  local root="$1" pkg="$2" name="$3"
  cat > "$root/packages/$pkg/package.json" <<EOF
{ "name": "$name", "version": "0.0.0" }
EOF
}

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
# SMI-6050 Wave 3: Tier-B fixture builder. Writes a minimal synthetic
# package-lock.json into $root with:
#   - a root-level linux-only entry (@turbo/linux-arm64)
#   - a nested-under-a-dependency linux-only entry, SAME family as a root
#     sibling at a different nesting depth (@rolldown/binding-linux-arm64-gnu,
#     both root and astro-vendored)
#   - a non-linux (darwin) sibling entry that must NOT be emitted
# Deliberately creates NO corresponding node_modules/ directories anywhere
# under $root — this is the whole point of these tests (see header note
# above).
# -----------------------------------------------------------------------
make_tier_b_lockfile() {
  local root="$1"
  mkdir -p "$root"
  cat > "$root/package-lock.json" <<'EOF'
{
  "name": "fixture",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture", "version": "0.0.0" },
    "node_modules/@turbo/linux-arm64": {
      "version": "1.2.3",
      "os": ["linux"],
      "cpu": ["arm64"]
    },
    "node_modules/@rolldown/binding-linux-arm64-gnu": {
      "version": "9.9.9",
      "os": ["linux"],
      "cpu": ["arm64"]
    },
    "node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu": {
      "version": "8.8.8",
      "os": ["linux"],
      "cpu": ["arm64"]
    },
    "node_modules/@turbo/darwin-arm64": {
      "version": "1.2.3",
      "os": ["darwin"],
      "cpu": ["arm64"]
    }
  }
}
EOF
}

# -----------------------------------------------------------------------
# Test 21 (SMI-6050 Wave 3): Tier-B volume-reference lines and top-level
# volume declarations are emitted for a root-level AND a
# nested-under-a-dependency fixture entry, with ZERO corresponding host
# node_modules/ directories present anywhere under the fixture root — this
# is the specific regression this wave must prove it avoids (a host `-d`
# gate would emit nothing here at all).
# -----------------------------------------------------------------------
TIERBROOT=$(mktemp -d)
make_repo "$TIERBROOT" core
make_pkg_json "$TIERBROOT" core "@skillsmith/core"
make_tier_b_lockfile "$TIERBROOT"
mkdir -p "$TIERBROOT/node_modules"   # root node_modules exists, but NONE of the tier-b package dirs do
OUT21MOUNTS=$(enumerate_compose_node_modules_mounts "$TIERBROOT")
OUT21VOLS=$(enumerate_native_module_volumes "$TIERBROOT")
assert_contains "test21: root-level turbo mount emitted despite missing host dir" \
  "      - native-seed-turbo-linux-arm64:/app/node_modules/@turbo/linux-arm64" "$OUT21MOUNTS"
assert_contains "test21: nested rolldown (astro-vendored) mount emitted despite missing host dir" \
  "      - native-seed-astro-node_modules-rolldown-binding-linux-arm64-gnu:/app/node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu" "$OUT21MOUNTS"
assert_contains "test21: root-level turbo volume declared despite missing host dir" \
  "  native-seed-turbo-linux-arm64:" "$OUT21VOLS"
assert_contains "test21: nested rolldown volume declared despite missing host dir" \
  "  native-seed-astro-node_modules-rolldown-binding-linux-arm64-gnu:" "$OUT21VOLS"

# -----------------------------------------------------------------------
# Test 22 (SMI-6050 Wave 3, plan doc "What Changes" #3): the root-level and
# nested-under-a-dependency entries for the SAME package family
# (@rolldown/binding-linux-arm64-gnu at two independently-versioned nesting
# depths) sanitize to two DISTINCT volume names — no collision.
# -----------------------------------------------------------------------
assert_contains "test22: root-level rolldown mount emitted with its OWN distinct name" \
  "      - native-seed-rolldown-binding-linux-arm64-gnu:/app/node_modules/@rolldown/binding-linux-arm64-gnu" "$OUT21MOUNTS"
ROOT_ROLLDOWN_LINES=$(printf '%s\n' "$OUT21MOUNTS" | grep -c '^      - native-seed-rolldown-binding-linux-arm64-gnu:' || true)
NESTED_ROLLDOWN_LINES=$(printf '%s\n' "$OUT21MOUNTS" | grep -c '^      - native-seed-astro-node_modules-rolldown-binding-linux-arm64-gnu:' || true)
assert_eq "test22: exactly 1 root-level rolldown mount line" 1 "$ROOT_ROLLDOWN_LINES"
assert_eq "test22: exactly 1 nested rolldown mount line (distinct from root)" 1 "$NESTED_ROLLDOWN_LINES"

# -----------------------------------------------------------------------
# Test 23 (SMI-6050 Wave 3): a non-linux (darwin) fixture entry is NOT
# emitted — mirrors the derivation script's own `os` filter (Wave 1).
# -----------------------------------------------------------------------
assert_not_contains "test23: darwin-only @turbo variant is NOT emitted" \
  "darwin" "$OUT21MOUNTS"
assert_eq "test23: exactly 3 tier-b (native-seed) mount lines total (turbo + root-rolldown + nested-rolldown, darwin excluded)" \
  3 "$(printf '%s\n' "$OUT21MOUNTS" | grep -c '^      - native-seed-' || true)"
rm -rf "$TIERBROOT"

# -----------------------------------------------------------------------
# Test 24 (SMI-6050 Wave 3, rollback control): Tier-B lines disappear
# entirely under SKILLSMITH_TIER_B_SEED_DISABLE=1, in BOTH
# enumerate_compose_node_modules_mounts and enumerate_native_module_volumes.
# -----------------------------------------------------------------------
TIERBDISABLEROOT=$(mktemp -d)
make_repo "$TIERBDISABLEROOT" core
make_pkg_json "$TIERBDISABLEROOT" core "@skillsmith/core"
make_tier_b_lockfile "$TIERBDISABLEROOT"
OUT24MOUNTS=$(SKILLSMITH_TIER_B_SEED_DISABLE=1 enumerate_compose_node_modules_mounts "$TIERBDISABLEROOT")
OUT24VOLS=$(SKILLSMITH_TIER_B_SEED_DISABLE=1 enumerate_native_module_volumes "$TIERBDISABLEROOT")
assert_eq "test24: zero tier-b mount lines under SKILLSMITH_TIER_B_SEED_DISABLE=1" \
  0 "$(printf '%s\n' "$OUT24MOUNTS" | grep -c '^      - native-seed-' || true)"
assert_eq "test24: zero tier-b volume declarations under SKILLSMITH_TIER_B_SEED_DISABLE=1" \
  0 "$(printf '%s\n' "$OUT24VOLS" | grep -c '^  native-seed-' || true)"
rm -rf "$TIERBDISABLEROOT"

# -----------------------------------------------------------------------
# Test 25 (SMI-6050 Wave 3): Tier-B volume declarations use the same
# driver: local / no driver_opts / SMI-5750 ownership-label shape as Tier-A
# (never `type: tmpfs` — same noexec-breaks-dlopen()/execve() rationale).
# -----------------------------------------------------------------------
TIERBSHAPEROOT=$(mktemp -d)
make_repo "$TIERBSHAPEROOT" core
make_pkg_json "$TIERBSHAPEROOT" core "@skillsmith/core"
make_tier_b_lockfile "$TIERBSHAPEROOT"
OUT25VOLS=$(enumerate_native_module_volumes "$TIERBSHAPEROOT")
TURBO_VOL_BLOCK=$(printf '%s\n' "$OUT25VOLS" | grep -A3 -F "  native-seed-turbo-linux-arm64:")
assert_eq "test25: turbo volume block is driver: local + SMI-5750 ownership label, no driver_opts" \
  "  native-seed-turbo-linux-arm64:
    driver: local
    labels:
      app.skillsmith.owned: \"true\"" "$TURBO_VOL_BLOCK"
assert_not_contains "test25: no driver_opts in tier-b volumes" "driver_opts" "$OUT25VOLS"
assert_not_contains "test25: no tmpfs annotation in tier-b volumes" "tmpfs" "$OUT25VOLS"
rm -rf "$TIERBSHAPEROOT"

# -----------------------------------------------------------------------
# Test 26 (SMI-6050 post-merge review finding): a derivation-script FAILURE
# (malformed package-lock.json, here — same effect as a broken Node install
# or a bug in the script itself) must be LOUD (a stderr message identifying
# the real cause) and must emit ZERO tier-b lines — never silently succeed
# with an empty result indistinguishable from "this repo has zero tier-b
# packages". Covers all three call sites (both enumerate_* emission
# functions plus ensure_tier_b_mount_sources).
# -----------------------------------------------------------------------
TIERBBROKENROOT=$(mktemp -d)
make_repo "$TIERBBROKENROOT" core
make_pkg_json "$TIERBBROKENROOT" core "@skillsmith/core"
mkdir -p "$TIERBBROKENROOT"
echo '{ this is not valid json' >"$TIERBBROKENROOT/package-lock.json"

OUT26MOUNTS_ALL=$(enumerate_compose_node_modules_mounts "$TIERBBROKENROOT" 2>&1)
OUT26MOUNTS_STDOUT=$(enumerate_compose_node_modules_mounts "$TIERBBROKENROOT" 2>/dev/null)
assert_contains "test26: enumerate_compose_node_modules_mounts surfaces a loud ERROR on derivation failure" \
  "ERROR: scripts/lib/linux-optional-packages.mjs failed" "$OUT26MOUNTS_ALL"
assert_eq "test26: enumerate_compose_node_modules_mounts emits zero tier-b mount lines on derivation failure" \
  0 "$(printf '%s\n' "$OUT26MOUNTS_STDOUT" | grep -c '^      - native-seed-' || true)"

OUT26VOLS_ALL=$(enumerate_native_module_volumes "$TIERBBROKENROOT" 2>&1)
OUT26VOLS_STDOUT=$(enumerate_native_module_volumes "$TIERBBROKENROOT" 2>/dev/null)
assert_contains "test26: enumerate_native_module_volumes surfaces a loud ERROR on derivation failure" \
  "ERROR: scripts/lib/linux-optional-packages.mjs failed" "$OUT26VOLS_ALL"
assert_eq "test26: enumerate_native_module_volumes emits zero tier-b volume declarations on derivation failure" \
  0 "$(printf '%s\n' "$OUT26VOLS_STDOUT" | grep -c '^  native-seed-' || true)"

# ensure_tier_b_mount_sources returns non-zero BY DESIGN on derivation
# failure — guarded with `if`/`||` throughout so that non-zero return never
# trips this file's own `set -e`.
OUT26MKDIR_STATUS=0
OUT26MKDIR_ERR=$(ensure_tier_b_mount_sources "$TIERBBROKENROOT" 2>&1 1>/dev/null) || OUT26MKDIR_STATUS=$?
assert_contains "test26: ensure_tier_b_mount_sources surfaces a loud ERROR on derivation failure" \
  "ERROR: scripts/lib/linux-optional-packages.mjs failed" "$OUT26MKDIR_ERR"
assert_eq "test26: ensure_tier_b_mount_sources returns non-zero on derivation failure" \
  1 "$OUT26MKDIR_STATUS"
rm -rf "$TIERBBROKENROOT"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
