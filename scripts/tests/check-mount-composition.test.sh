#!/usr/bin/env bash
# SMI-6516/SMI-6520 Wave 1 Step 1: fixture-driven tests for the shared
# mount-composition checker.
#
# FIXTURE-ONLY BY DESIGN. Wave 1 is "build and prove the detector offline --
# no fleet mutation", so nothing here starts, stops, inspects or execs into a
# container. Every input is synthesised in a temp dir: mountinfo (including
# kernel-escaped paths), compose files (short form, long-form tmpfs, malformed
# entries), ELF and Mach-O binaries built from raw magic bytes, a read-only
# parent, an undeclared cache dir, and a symlink-clamp link map.
#
# Coverage map to the plan's contract:
#   A1  expected inventory from the override/compose, never from mounts
#   A2  normalised destination-SET diff (never a count, never byte-identical)
#   A3  mountinfo \040 \011 \012 \134 un-escaping
#   A4  per-copy ABI identity (ELF vs Mach-O) + arch
#   A5  per-package traversal-path writability
#   A6  read-only parent still read-only
#   A7  undeclared cache directories reported
#   A8  ownership / readability (NOT the exec bit -- see T-A8-1)
# and to the V-table: V3, V4, V5, V6, V7, V8, V9 are exercised here; V1/V2 are
# assertions about repair-worktree-container-symlinks.sh (plan §2, Wave 2) and
# are deliberately NOT claimed by this file.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$SCRIPT_DIR/lib/check-mount-composition.sh"
# shellcheck source=../lib/check-mount-composition.helpers.sh
source "$SCRIPT_DIR/lib/check-mount-composition.helpers.sh"

fail_n=0
pass_n=0

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "PASS $name"
        pass_n=$((pass_n + 1))
    else
        echo "FAIL $name: expected='$expected' actual='$actual'"
        fail_n=$((fail_n + 1))
    fi
}

assert_contains() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*)
            echo "PASS $name"
            pass_n=$((pass_n + 1))
            ;;
        *)
            echo "FAIL $name: missing '$needle'"
            fail_n=$((fail_n + 1))
            ;;
    esac
}

assert_not_contains() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*)
            echo "FAIL $name: unexpectedly found '$needle'"
            fail_n=$((fail_n + 1))
            ;;
        *)
            echo "PASS $name"
            pass_n=$((pass_n + 1))
            ;;
    esac
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ===========================================================================
# Unit: mc_normalize_path -- ".." clamped at root.
# This is the mechanism the whole worktree topology rests on: a host-correct
# ../../../../ overshoots inside the container and clamps at /, anchoring ~165
# declared destinations outside /app.
# ===========================================================================
assert_eq "T-NORM-1 clamp at root" "/node_modules" "$(mc_normalize_path /app/../../node_modules)"
assert_eq "T-NORM-2 four-up clamp" "/packages/core/node_modules" \
    "$(mc_normalize_path /app/packages/core/../../../../packages/core/node_modules)"
assert_eq "T-NORM-3 bare dotdot" "/" "$(mc_normalize_path /..)"
assert_eq "T-NORM-4 root" "/" "$(mc_normalize_path /)"
assert_eq "T-NORM-5 dot segment" "/a/b" "$(mc_normalize_path /a/./b)"
assert_eq "T-NORM-6 double slash" "/a/b" "$(mc_normalize_path //a//b)"
assert_eq "T-NORM-7 embedded space preserved" "/a b/c" "$(mc_normalize_path '/a b/c')"
assert_eq "T-NORM-8 over-clamp" "/b" "$(mc_normalize_path /a/../../../b)"

# ===========================================================================
# A3 -- mountinfo un-escaping. An un-decoded path never matches a declared
# destination, turning a PRESENT mount into a false "missing".
# ===========================================================================
assert_eq "T-A3-1 space" "/app/my dir" "$(mc_unescape '/app/my\040dir')"
assert_eq "T-A3-2 tab" "$(printf '/app/a\tb')" "$(mc_unescape '/app/a\011b')"
assert_eq "T-A3-3 backslash" '/app/a\b' "$(mc_unescape '/app/a\134b')"
assert_eq "T-A3-4 newline" "$(printf '/app/a\nb')" "$(mc_unescape '/app/a\012b')"
# Backslash must decode LAST, or "\134040" would wrongly become a space.
assert_eq "T-A3-5 backslash decoded last" '/app/\040' "$(mc_unescape '/app/\134040')"
assert_eq "T-A3-6 no escapes untouched" "/app/node_modules" "$(mc_unescape /app/node_modules)"

# ===========================================================================
# A1 -- expected inventory parsing.
# ===========================================================================
cat >"$WORK/compose-a1.yml" <<'YML'
services:
  dev:
    container_name: x-dev-1
    ports:
      - "3730:3000"
    volumes:
      - /host/root/node_modules:/app/node_modules:ro
      - /host/root/node_modules/.vite:/app/node_modules/.vite
      - type: tmpfs
        target: /app/node_modules/@skillsmith
        tmpfs:
          size: 1048576
      - native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3
      - ${HOME}/.claude/projects/${ENCODED:-}/memory:/skillsmith-memory:ro
      - justonefield
  test:
    container_name: x-test-1
    volumes:
      - /host/root/node_modules:/app/node_modules:ro
      - /decoy/only/in/test:/app/DECOY
volumes:
  native-seed-core-better-sqlite3:
    driver: local
YML

a1="$(mc_parse_compose_volumes "$WORK/compose-a1.yml" dev)"
assert_eq "T-A1-1 dev entry count" "6" "$(printf '%s\n' "$a1" | grep -c .)"
assert_contains "T-A1-2 long-form tmpfs destination recovered" \
    "/app/node_modules/@skillsmith" "$a1"
assert_contains "T-A1-3 :ro option captured" "$(printf '/app/node_modules\tro')" "$a1"
assert_contains "T-A1-4 colon-in-source (\${VAR:-}) parsed, not dropped" "/skillsmith-memory" "$a1"
assert_contains "T-A1-5 malformed entry is LOUD, not skipped" "PARSE_ERROR" "$a1"
# Service scoping is load-bearing: a real generated override declares the
# identical ~163-entry list under BOTH dev and test, so an unscoped parse
# doubles every destination and the "expected" set becomes fiction.
assert_not_contains "T-A1-6 test-service entry excluded from dev parse" "/app/DECOY" "$a1"
assert_eq "T-A1-7 unknown service yields nothing" "0" \
    "$(mc_parse_compose_volumes "$WORK/compose-a1.yml" nosuch | grep -c . || true)"

# ===========================================================================
# A2 + A3 + the symlink clamp, end to end through the real checker.
#
# The fixture reproduces the measured worktree shape: /app/node_modules and
# /app/packages/<pkg>/node_modules are symlinks escaping /app, so the kernel
# records /node_modules/... and /packages/<pkg>/node_modules/...
# ===========================================================================
cat >"$WORK/compose-a2.yml" <<'YML'
services:
  dev:
    volumes:
      - /host/nm:/app/node_modules:ro
      - /host/nm/.vite:/app/node_modules/.vite
      - /host/core:/app/packages/core/node_modules:ro
      - /host/core/.vite:/app/packages/core/node_modules/.vite
      - /host/core/.astro:/app/packages/core/node_modules/.astro
      - native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3
      - /host/spaced:/app/packages/core/node_modules/spaced dir
YML

printf '%s\n' \
    "/app	../../node_modules" \
    "/app/node_modules	../../node_modules" \
    "/app/packages/core/node_modules	../../../../packages/core/node_modules" \
    >"$WORK/linkmap-a2.tsv"
# The map must use real tabs; rebuild it explicitly to avoid relying on the
# literal above being tab-separated after any editor round-trip.
{
    printf '/app/node_modules\t../../node_modules\n'
    printf '/app/packages/core/node_modules\t../../../../packages/core/node_modules\n'
} >"$WORK/linkmap-a2.tsv"

# Synthetic mountinfo. Note:
#   * /packages/core/node_modules/.astro and .../better-sqlite3 are ABSENT
#     (the detachment under test)
#   * the spaced path is written with the kernel's \040 escape (A3/V7)
#   * a large block of unrelated mounts is included so that any count-based
#     comparison would be satisfied while destinations are missing (M-7)
{
    echo "1 0 0:1 / / rw,relatime - overlay overlay rw"
    echo "2 1 0:43 /host/wt /app rw,relatime - virtiofs virtiofs0 rw"
    echo "3 1 0:43 /host/nm /node_modules ro,relatime - virtiofs virtiofs0 rw"
    echo "4 1 0:43 /host/nm/.vite /node_modules/.vite rw,relatime - virtiofs virtiofs0 rw"
    echo "5 1 0:43 /host/core /packages/core/node_modules ro,relatime - virtiofs virtiofs0 rw"
    echo "6 1 0:43 /host/core/.vite /packages/core/node_modules/.vite rw,relatime - virtiofs virtiofs0 rw"
    echo "7 1 0:43 /host/spaced /packages/core/node_modules/spaced\040dir rw,relatime - virtiofs virtiofs0 rw"
    for i in $(seq 10 140); do
        echo "$i 1 0:9 / /noise/$i rw,relatime - tmpfs tmpfs rw"
    done
} >"$WORK/mountinfo-a2"

out_a2="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-a2" \
    --link-map "$WORK/linkmap-a2.tsv" \
    --no-report 2>&1)"

assert_contains "T-A2-1 reports the missing .astro overlay by name" \
    "/packages/core/node_modules/.astro" "$out_a2"
assert_contains "T-A2-2 reports the missing native volume by name (V4)" \
    "/packages/core/node_modules/better-sqlite3" "$out_a2"
assert_contains "T-A2-3 composition line reports 7 declared / 2 missing" \
    "in-scope declared destinations: 7 | mounted: 5 | MISSING: 2" "$out_a2"
# V7 -- the escaped-space destination is PRESENT and must not be reported.
assert_not_contains "T-A2-4 (V7) escaped-space path matched, not a false missing" \
    "spaced" "$(printf '%s\n' "$out_a2" | grep 'NOT mounted' || true)"
# The clamp must have been applied; if it had not, the checker would report
# every /app/... destination missing instead of 2 of 7.
assert_not_contains "T-A2-5 clamp applied (no /app/... reported missing)" \
    "NOT mounted: /app/" "$out_a2"
# M-7 -- 138 mountinfo lines vs 7 declared: a count says nothing.
assert_contains "T-A2-6 warn-only summary (D-20)" "warn-only" "$out_a2"

# A1 anti-vacuity, stated as an assertion rather than a comment: the expected
# set must come from the compose file even when mountinfo is EMPTY. A checker
# that derived expectations from actual mounts would report 0 missing here.
: >"$WORK/mountinfo-empty"
out_empty="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-empty" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-A1-8 empty mountinfo => ALL 7 missing, not 0 (anti-vacuous)" \
    "in-scope declared destinations: 7 | mounted: 0 | MISSING: 7" "$out_empty"

# V9 -- a mixed result must not summarise as green.
assert_contains "T-V9-1 mixed result is not green" "2 finding(s)" "$out_a2"
# V8 -- an all-pass run reports its denominator and zero findings.
{
    echo "1 0 0:1 / / rw,relatime - overlay overlay rw"
    echo "3 1 0:43 /host/nm /node_modules ro,relatime - virtiofs virtiofs0 rw"
    echo "4 1 0:43 /host/nm/.vite /node_modules/.vite rw,relatime - virtiofs virtiofs0 rw"
    echo "5 1 0:43 /host/core /packages/core/node_modules ro,relatime - virtiofs virtiofs0 rw"
    echo "6 1 0:43 /host/core/.vite /packages/core/node_modules/.vite rw,relatime - virtiofs virtiofs0 rw"
    echo "7 1 0:43 /host/core/.astro /packages/core/node_modules/.astro rw,relatime - virtiofs virtiofs0 rw"
    echo "8 1 0:43 /v /packages/core/node_modules/better-sqlite3 rw,relatime - ext4 /dev/vda rw"
    echo "9 1 0:43 /host/spaced /packages/core/node_modules/spaced\040dir rw,relatime - virtiofs virtiofs0 rw"
} >"$WORK/mountinfo-clean"
out_clean="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-V8-1 all-pass reports denominator" \
    "7 in-scope destination(s) checked, 0 findings" "$out_clean"
assert_not_contains "T-V8-2 all-pass emits no FAIL" "FAIL" "$out_clean"

# ===========================================================================
# A6 -- a declared :ro parent mounted rw is a finding (V3-adjacent: a
# structurally-wrong-but-present mount must not pass).
# ===========================================================================
sed 's| /packages/core/node_modules ro,| /packages/core/node_modules rw,|' \
    "$WORK/mountinfo-clean" >"$WORK/mountinfo-rw-parent"
out_rw="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-rw-parent" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-A6-1 declared :ro mounted rw is reported" \
    "declared :ro but mounted rw" "$out_rw"

# Superblock options must not mask a per-mount ro. Measured on a live
# container: a :ro bind reports ro in field 6 while its superblock says rw.
assert_eq "T-A6-2 per-mount ro wins over superblock rw" "ro" \
    "$(printf '5 1 0:43 /h /packages/core/node_modules ro,relatime - virtiofs v0 rw\n' >"$WORK/mi1"; mc_parse_mountinfo "$WORK/mi1" | cut -f3)"
assert_eq "T-A6-3 superblock ro also detected" "ro" \
    "$(printf '5 1 0:43 /h /x rw,relatime - ext4 /dev/vda ro\n' >"$WORK/mi2"; mc_parse_mountinfo "$WORK/mi2" | cut -f3)"
# The optional-field run before "-" is variable length and must be FOUND.
assert_eq "T-MI-1 variable optional fields handled" "/x" \
    "$(printf '5 1 0:43 /h /x rw,relatime shared:2 master:3 - ext4 /dev/vda rw\n' >"$WORK/mi3"; mc_parse_mountinfo "$WORK/mi3" | cut -f1)"

# ===========================================================================
# A4 -- ABI identity on synthetic ELF / Mach-O fixtures (V5).
# A presence check passes on precisely the broken state, so the magic bytes
# are the assertion.
# ===========================================================================
# e_machine is a 2-byte LE field at offset 0x12: aarch64 = 183 = 0xB7 (\267),
# x86-64 = 62 = 0x3E (\076).
printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\003\000\267\000' >"$WORK/fake-aarch64.node"
printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\003\000\076\000' >"$WORK/fake-x86.node"
printf '\317\372\355\376\014\000\000\001' >"$WORK/fake-macho.node"
printf '\312\376\272\276\000\000\000\002' >"$WORK/fake-fat.node"
printf 'not a binary at all' >"$WORK/fake-text.node"

assert_eq "T-A4-1 ELF detected" "ELF" "$(mc_binary_abi "$WORK/fake-aarch64.node")"
assert_eq "T-A4-2 (V5) Mach-O detected, NOT accepted as present" "MACHO" \
    "$(mc_binary_abi "$WORK/fake-macho.node")"
assert_eq "T-A4-3 fat Mach-O detected" "FAT" "$(mc_binary_abi "$WORK/fake-fat.node")"
assert_eq "T-A4-4 non-binary reported, not assumed ok" "OTHER:6e6f7420" \
    "$(mc_binary_abi "$WORK/fake-text.node")"
assert_eq "T-A4-5 missing file reported" "UNREADABLE" "$(mc_binary_abi "$WORK/definitely-absent")"
assert_eq "T-A4-6 aarch64 e_machine" "aarch64" "$(mc_elf_arch "$WORK/fake-aarch64.node")"
assert_eq "T-A4-7 x86-64 e_machine" "x86-64" "$(mc_elf_arch "$WORK/fake-x86.node")"

# --- A4 foreign-platform filter -------------------------------------------
# Multi-platform prebuild bundles ship Mach-O and PE binaries BY DESIGN
# (argon2's prebuildify layout, napi-rs's name.<os>-<arch>-<abi>.node). Without
# this filter the probe produced 20 findings on a HEALTHY main checkout.
# Convention: mc_is_foreign_platform_binary returns 0 == "foreign, skip".
foreign_case() { # path -> "skip" | "assert"
    if mc_is_foreign_platform_binary "$1" "$2"; then echo skip; else echo assert; fi
}
assert_eq "T-A4P-1 darwin payload skipped" "skip" \
    "$(foreign_case /n/argon2/prebuilds/darwin-arm64/argon2.armv8.glibc.node aarch64)"
assert_eq "T-A4P-2 win32 payload skipped" "skip" \
    "$(foreign_case /n/@ruvector/rvf-node/rvf-node.win32-x64-msvc.node aarch64)"
assert_eq "T-A4P-3 foreign linux arch skipped" "skip" \
    "$(foreign_case /n/@ruvector/rvf-node/rvf-node.linux-x64-gnu.node aarch64)"
assert_eq "T-A4P-4 armv7 skipped on aarch64" "skip" \
    "$(foreign_case /n/argon2/prebuilds/linux-arm/argon2.armv7.glibc.node aarch64)"
# The genuinely broken case MUST survive the filter: the filename itself claims
# to be the linux-arm64 build, so a Mach-O there is a real fault.
assert_eq "T-A4P-5 OUR platform is asserted on, not skipped" "assert" \
    "$(foreign_case /n/@ruvector/attention-linux-arm64-gnu/attention.linux-arm64-gnu.node aarch64)"
assert_eq "T-A4P-6 platform-neutral path is asserted on" "assert" \
    "$(foreign_case /n/better-sqlite3/build/Release/better_sqlite3.node aarch64)"
assert_eq "T-A4P-7 musl variant of our arch still asserted" "assert" \
    "$(foreign_case /n/@img/sharp-linuxmusl-arm64/lib/sharp-linuxmusl-arm64-0.35.4.node aarch64)"
assert_eq "T-A4P-8 x86-64 host: x64 payload is ours" "assert" \
    "$(foreign_case /n/@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node x86-64)"
assert_eq "T-A4P-9 x86-64 host: arm64 payload is foreign" "skip" \
    "$(foreign_case /n/@rollup/rollup-linux-arm64-gnu/rollup.linux-arm64-gnu.node x86-64)"
# An unknown kernel must assert nothing away rather than guess.
assert_eq "T-A4P-10 unknown kernel does not skip" "assert" \
    "$(foreign_case /n/whatever/linux-x64/foo.node unknown)"

# Version identity: a stale seed of the RIGHT ABI must still be catchable.
mkdir -p "$WORK/pkgdir"
printf '{"name":"better-sqlite3","version":"12.10.0"}' >"$WORK/pkgdir/package.json"
assert_eq "T-A4-8 seeded version read" "12.10.0" "$(mc_package_version "$WORK/pkgdir")"
assert_eq "T-A4-9 absent package.json reported" "unknown" "$(mc_package_version "$WORK/nope")"

# ===========================================================================
# A8 -- ownership / readability.
#
# T-A8-1 encodes a MEASURED correction: dlopen does NOT require the execute
# bit. Every .node in a live container is mode 0644 and process.dlopen()
# succeeds on one. Asserting +x flagged 27 of 28 healthy binaries, so the
# checker asserts READABILITY and reserves the exec-bit check for bin/.
# ===========================================================================
printf 'x' >"$WORK/readable.node"
chmod 0644 "$WORK/readable.node"
assert_contains "T-A8-1 mode 0644 .node reports noexec WITHOUT being a failure" \
    ":noexec" "$(mc_file_ownership "$WORK/readable.node")"
assert_eq "T-A8-2 absent file reported" "missing" "$(mc_file_ownership "$WORK/definitely-absent")"
chmod 0755 "$WORK/readable.node"
assert_contains "T-A8-3 exec bit surfaced when present" ":exec" \
    "$(mc_file_ownership "$WORK/readable.node")"

# ===========================================================================
# A5 / A6-write / A7 -- live probes against a synthetic tree.
#
# A read-only PARENT fixture is built with chmod a-w rather than a real mount,
# so the write probes exercise their real code path offline. (chmod is not
# EROFS, but it is the same failed-write outcome the probe classifies.)
# ===========================================================================
PKGA="$WORK/live/packages/alpha/node_modules"
PKGB="$WORK/live/packages/beta/node_modules"
mkdir -p "$PKGA/.vite" "$PKGB/.vite" "$PKGA/.undeclared-cache" "$PKGA/.bin"
cat >"$WORK/compose-live.yml" <<YML
services:
  dev:
    volumes:
      - /h/a:$PKGA:ro
      - /h/a/.vite:$PKGA/.vite
      - /h/b:$PKGB:ro
      - /h/b/.vite:$PKGB/.vite
YML
{
    echo "1 0 0:1 / / rw,relatime - overlay overlay rw"
    echo "2 1 0:43 /h/a $PKGA ro,relatime - virtiofs v0 rw"
    echo "3 1 0:43 /h/a/.vite $PKGA/.vite rw,relatime - virtiofs v0 rw"
    echo "4 1 0:43 /h/b $PKGB ro,relatime - virtiofs v0 rw"
    echo "5 1 0:43 /h/b/.vite $PKGB/.vite rw,relatime - virtiofs v0 rw"
} >"$WORK/mountinfo-live"

# V6 -- make package beta's overlay unwritable; alpha must still report ok.
chmod a-w "$PKGB/.vite"
out_live="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-live.yml" --mountinfo "$WORK/mountinfo-live" \
    --scope "$WORK/live" --live-write --no-report 2>&1)"
chmod u+w "$PKGB/.vite" 2>/dev/null || true

assert_contains "T-A5-1 (V6) names the one unwritable package" \
    "packages/beta/node_modules/.vite" "$(printf '%s\n' "$out_live" | grep 'A5.*NOT WRITABLE' || true)"
assert_not_contains "T-A5-2 (V6) the healthy package is NOT reported" \
    "packages/alpha/node_modules/.vite/ (EROFS" "$out_live"
assert_contains "T-A5-3 A5 reports its denominator" \
    "probed 2 declared writable overlay(s)" "$out_live"
assert_contains "T-A7-1 undeclared cache dir reported" ".undeclared-cache" "$out_live"
assert_not_contains "T-A7-2 .bin is not flagged (installed content, not a cache)" \
    "node_modules/.bin (no declared" "$out_live"
assert_contains "T-A6-4 A6 write probe reports its denominator" \
    "write-probed" "$out_live"

# ===========================================================================
# Exit semantics: warn-only by default (D-20), blocking under --strict.
# ===========================================================================
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-a2" --link-map "$WORK/linkmap-a2.tsv" \
    --no-report --quiet >/dev/null 2>&1
assert_eq "T-EXIT-1 warn-only exits 0 despite findings" "0" "$?"

bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-a2" --link-map "$WORK/linkmap-a2.tsv" \
    --no-report --quiet --strict >/dev/null 2>&1
assert_eq "T-EXIT-2 --strict exits 1 on findings" "1" "$?"

SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1 bash "$CHECKER" --root "$WORK" \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-a2" \
    --no-report --strict >/dev/null 2>&1
assert_eq "T-EXIT-3 disable var short-circuits to 0" "0" "$?"

# ===========================================================================
# Report channel: the JSON state file the host-side consumer will read.
# Proven host-visible from a WORKTREE container (Wave 1 Step 2).
# ===========================================================================
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-a2" --link-map "$WORK/linkmap-a2.tsv" \
    --report "$WORK/report.json" --quiet >/dev/null 2>&1
report="$(cat "$WORK/report.json" 2>/dev/null || echo '')"
assert_contains "T-RPT-1 report records the missing count" '"missing":2' "$report"
assert_contains "T-RPT-2 report names missing destinations" \
    '/packages/core/node_modules/.astro' "$report"
assert_contains "T-RPT-3 report records the expected denominator" '"in_scope_expected":7' "$report"

echo
echo "-----------------------------------------------------------"
echo "check-mount-composition: $pass_n passed, $fail_n failed (denominator: $((pass_n + fail_n)))"
[ "$fail_n" -eq 0 ] || exit 1
