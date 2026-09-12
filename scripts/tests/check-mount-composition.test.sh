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
skip_n=0

# The suite's own not-evaluated discipline, matching the checker's SKIP channel
# (`SKIP [A4] --live not set`, asserted at T-NE-12). A block whose PRECONDITION
# is absent must neither fail nor silently pass: it reports SKIP, names which
# precondition was missing and what was therefore never asserted, and counts
# toward the denominator so "ran" and "did not run" stay distinguishable.
#
# This exists because the alternative was measured and is worse: on the macOS
# host the T-SEED block produced 5 reds and ONE SPURIOUS GREEN -- T-SEED-10 was
# an assert_not_contains, so it passed precisely because nothing ran. That is
# the vacuous-success shape this whole checker exists to eliminate, reproduced
# inside its own test suite.
skip_test() {
    local tag="$1" name="$2" reason="$3"
    echo "SKIP [$tag] $name -- $reason"
    skip_n=$((skip_n + 1))
}

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

# CANONICALISED, and that is load-bearing, not tidiness. On macOS `mktemp -d`
# returns a path under /var, and /var is a symlink to /private/var (`ls -ld
# /var` -> `/var -> private/var`). The checker RESOLVES every declared
# destination through real symlinks -- that is its entire purpose, the worktree
# `..`-clamp -- so an UNRESOLVED fixture path can never match its own mountinfo
# line, and every destination reads as "declared but NOT mounted".
#
# MEASURED: this is precisely what made T-SEED-7..12 fail on the macOS host
# while passing in the Linux container (where mktemp returns /tmp, not a
# symlink). It is a FIXTURE defect, not a platform limitation -- with the path
# canonicalised the block runs and passes on both. Blocks that pass
# `--link-map` were immune because that puts the resolver in fixture mode and
# no real symlink is ever read; the T-SEED block did not.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
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
# Record layout is <source>\t<destination>\t<kind>\t<options>. Options is LAST
# because it is the only field that can be empty and TAB is IFS whitespace --
# see T-A1-9/T-A1-10 below, which are the regression tests for that.
assert_contains "T-A1-3 :ro option captured" "$(printf '/app/node_modules\tshort\tro')" "$a1"
assert_contains "T-A1-4 colon-in-source (\${VAR:-}) parsed, not dropped" "/skillsmith-memory" "$a1"
assert_contains "T-A1-5 malformed entry is LOUD, not skipped" "PARSE_ERROR" "$a1"
# Service scoping is load-bearing: a real generated override declares the
# identical ~163-entry list under BOTH dev and test, so an unscoped parse
# doubles every destination and the "expected" set becomes fiction.
assert_not_contains "T-A1-6 test-service entry excluded from dev parse" "/app/DECOY" "$a1"
assert_eq "T-A1-7 unknown service yields nothing" "0" \
    "$(mc_parse_compose_volumes "$WORK/compose-a1.yml" nosuch | grep -c . || true)"

# --- Field-order regression (the tab-collapse trap) ------------------------
# TAB is an IFS *whitespace* character, so `IFS=$'\t' read -r a b c d` collapses
# a run of tabs: an empty field in the MIDDLE silently shifts every later field
# one position left, while an empty field at the END is simply assigned "".
# Measured: printf 'a\tb\t\td\n' | IFS=$'\t' read -r f1 f2 f3 f4 -> f3=d, f4=''.
# An earlier revision emitted <options> third, so every entry WITHOUT options
# delivered the literal string "short" into the caller's `opts` variable and
# left `kind` empty. It was harmless only by luck (`case ",short," in *,ro,*`
# does not match) and produced a live false positive the moment `kind` was
# actually consumed: both long-form tmpfs scopes were reported as substituted
# mounts on a HEALTHY container ("declared named volume tmpfs but backed by
# tmpfs"). These two cases pin the layout that prevents it.
a1_novol="$(printf '%s\n' "$a1" | awk -F'\t' '$2=="/app/node_modules/.vite"')"
assert_eq "T-A1-9 no-options entry: kind lands in field 3, options empty" \
    "short|" "$(printf '%s' "$a1_novol" | awk -F'\t' '{printf "%s|%s", $3, $4}')"
a1_tmpfs="$(printf '%s\n' "$a1" | awk -F'\t' '$2=="/app/node_modules/@skillsmith"')"
assert_eq "T-A1-10 tmpfs entry: kind=tmpfs survives to field 3" \
    "tmpfs|" "$(printf '%s' "$a1_tmpfs" | awk -F'\t' '{printf "%s|%s", $3, $4}')"
assert_eq "T-A1-11 IFS-tab read recovers kind and empty opts" "short||" \
    "$(printf '%s\n' "$a1_novol" | { IFS=$'\t' read -r _s _d k o; printf '%s|%s|' "$k" "$o"; })"

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
    # The named-volume line uses the REAL layout a local-driver volume produces
    # -- root=<docker-data-root>/volumes/<project>_<name>/_data -- measured on
    # this machine. The earlier placeholder root ("/v") is what a host BIND
    # looks like, so with A2's backing check in place the "all-pass" fixture was
    # no longer all-pass: it reproduced the very substitution T-SUB-1 tests.
    echo "8 1 254:1 /docker/volumes/testproj_native-seed-core-better-sqlite3/_data /packages/core/node_modules/better-sqlite3 rw,relatime master:1 - ext4 /dev/vda1 rw,discard"
    echo "9 1 0:43 /host/spaced /packages/core/node_modules/spaced\040dir rw,relatime - virtiofs virtiofs0 rw"
} >"$WORK/mountinfo-clean"
out_clean="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-V8-1 all-pass reports denominator" \
    "7 in-scope destination(s) checked; 0 finding(s)" "$out_clean"
assert_not_contains "T-V8-2 all-pass emits no FAIL" "FAIL" "$out_clean"
assert_not_contains "T-V8-3 all-pass evaluates every applicable assertion" \
    "NOT EVALUATED" "$out_clean"
assert_contains "T-V8-4 backing identity reports its own denominator" \
    "backing identity (volume/bind/tmpfs + volume name) compared for 7 mounted destination(s); 0 substituted" "$out_clean"

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
# A read-only PARENT fixture is built with chmod rather than a real mount, so
# the write probes exercise their real code path offline. (chmod is not EROFS,
# but it is the same failed-write outcome the probe classifies.)
#
# THE PROBES MUST RUN UNPRIVILEGED, and that is not a stylistic preference.
# Every command in this repo's dev container runs as root, and root bypasses
# the write bit entirely. MEASURED in the container: root writes successfully
# into a 0555 directory; uid 65534 gets EACCES on the same directory. So a
# `chmod a-w` fixture executed as root CANNOT REACH the state A5 exists to
# detect -- the write succeeds, A5 reports "0 not writable", and the assertion
# below fails for a reason that has nothing to do with the checker. That is
# exactly what happened: T-A5-1 was failing in the container on this branch
# before this change, while passing on the (non-root) macOS host.
mc_run_checker_unprivileged() {
    if [ "$(id -u)" = "0" ] && command -v setpriv >/dev/null 2>&1; then
        chmod -R a+rX "$WORK" 2>/dev/null || true
        setpriv --reuid=65534 --regid=65534 --clear-groups bash "$CHECKER" "$@"
    else
        bash "$CHECKER" "$@"
    fi
}
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

# V6 -- beta's overlay is unwritable, alpha's is writable, and BOTH declared
# :ro parents genuinely refuse a write (mode 0555 => r-x, so A6's write probe
# must report 0 wrongly accepted). Modes are set for the unprivileged uid the
# checker runs as above.
chmod 0555 "$PKGB/.vite"
chmod 0777 "$PKGA/.vite"
chmod 0555 "$PKGA" "$PKGB"
out_live="$(mc_run_checker_unprivileged --root "$WORK" --mode worktree \
    --compose "$WORK/compose-live.yml" --mountinfo "$WORK/mountinfo-live" \
    --scope "$WORK/live" --live-write --no-report 2>&1)"
chmod 0755 "$PKGA" "$PKGB" 2>/dev/null || true
chmod u+w "$PKGB/.vite" 2>/dev/null || true

assert_contains "T-A5-1 (V6) names the one unwritable package" \
    "packages/beta/node_modules/.vite" "$(printf '%s\n' "$out_live" | grep 'A5.*NOT WRITABLE' || true)"
assert_not_contains "T-A5-2 (V6) the healthy package is NOT reported" \
    "packages/alpha/node_modules/.vite/ (EROFS" "$out_live"
assert_contains "T-A5-3 A5 reports its denominator" \
    "probed 2 declared writable overlay(s) through their traversal path; 1 not writable" "$out_live"
assert_contains "T-A7-1 undeclared cache dir reported" ".undeclared-cache" "$out_live"
assert_not_contains "T-A7-2 .bin is not flagged (installed content, not a cache)" \
    "node_modules/.bin (no declared" "$out_live"
assert_contains "T-A6-4 A6 write probe reports its denominator" \
    "write-probed 2 declared :ro parent(s); 0 wrongly accepted a write" "$out_live"

# A6's write half is an ASSERTION, not decoration: SMI-5560's cross-checkout
# corruption is what the :ro exists to prevent, so a :ro parent that ACCEPTS a
# write is the critical finding. Same tree, alpha's parent made writable.
chmod 0777 "$PKGA"
out_rw_parent="$(mc_run_checker_unprivileged --root "$WORK" --mode worktree \
    --compose "$WORK/compose-live.yml" --mountinfo "$WORK/mountinfo-live" \
    --scope "$WORK/live" --live-write --no-report 2>&1)"
chmod 0755 "$PKGA" 2>/dev/null || true
assert_contains "T-A6-5 a :ro parent that accepts a write is reported by name" \
    "packages/alpha/node_modules" \
    "$(printf '%s\n' "$out_rw_parent" | grep 'ACCEPTED A WRITE' || true)"

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

# ===========================================================================
# A2 BACKING IDENTITY -- a mount at the right destination backed by the WRONG
# THING (finding 3).
#
# The values below are REAL, captured 2026-09-11 from live containers:
#   named volume  root=/docker/volumes/<project>_<name>/_data  fstype=ext4
#   host bind     root=/williamsmith/...                       fstype=virtiofs
#   tmpfs scope   root=/                                       fstype=tmpfs
# fstype and the bind's own source path are deliberately NOT asserted -- see
# check-mount-composition.identity.sh for the measurements that rule them out.
# ===========================================================================
source "$SCRIPT_DIR/lib/check-mount-composition.identity.sh"

assert_eq "T-BK-1 declared: named volume" "volume:native-seed-core-better-sqlite3" \
    "$(mc_declared_backing native-seed-core-better-sqlite3 short)"
assert_eq "T-BK-2 declared: '.' (docker-compose.yml's .:/app) is a BIND, not a volume named '.'" \
    "bind" "$(mc_declared_backing . short)"
assert_eq "T-BK-3 declared: unexpanded \${HOME} source is a bind" "bind" \
    "$(mc_declared_backing '${HOME}/.skillsmith' short)"
assert_eq "T-BK-4 declared: long-form tmpfs" "tmpfs" "$(mc_declared_backing tmpfs tmpfs)"
assert_eq "T-BK-5 actual: Docker Desktop volume root" \
    "volume:smi-6516-mount-composition_native-seed-core-better-sqlite3" \
    "$(mc_actual_backing ext4 /docker/volumes/smi-6516-mount-composition_native-seed-core-better-sqlite3/_data)"
assert_eq "T-BK-6 actual: plain-daemon volume root (portability)" "volume:proj_vol" \
    "$(mc_actual_backing overlay /var/lib/docker/volumes/proj_vol/_data)"
assert_eq "T-BK-7 actual: rootless volume root (portability)" "volume:p_v" \
    "$(mc_actual_backing ext4 /home/u/.local/share/docker/volumes/p_v/_data)"
assert_eq "T-BK-8 actual: virtiofs host bind" "bind" \
    "$(mc_actual_backing virtiofs /williamsmith/Documents/GitHub/Smith-Horn/skillsmith/packages/core/node_modules)"
assert_eq "T-BK-9 actual: a LINUX bind shares the volume's fstype -- so fstype cannot be the test" \
    "bind" "$(mc_actual_backing ext4 /home/u/repo/node_modules)"
assert_eq "T-BK-10 actual: tmpfs" "tmpfs" "$(mc_actual_backing tmpfs /)"

bk() { # want got -> "match" | "mismatch"
    if mc_backing_matches "$1" "$2" >/dev/null; then echo match; else echo mismatch; fi
}
assert_eq "T-BK-11 compose project prefix is accepted" "match" \
    "$(bk volume:native-seed-core-better-sqlite3 volume:smi-6516-mount-composition_native-seed-core-better-sqlite3)"
assert_eq "T-BK-12 unprefixed (external) volume is accepted" "match" \
    "$(bk volume:node_modules volume:node_modules)"
assert_eq "T-BK-13 THE SUBSTITUTION: volume declared, bind mounted" "mismatch" \
    "$(bk volume:native-seed-core-better-sqlite3 bind)"
assert_eq "T-BK-14 bind declared, volume mounted" "mismatch" "$(bk bind volume:foo)"
assert_eq "T-BK-15 tmpfs declared, bind mounted" "mismatch" "$(bk tmpfs bind)"
assert_eq "T-BK-16 wrong volume at the right destination" "mismatch" \
    "$(bk volume:native-seed-core-better-sqlite3 volume:proj_native-seed-esbuild)"
# The suffix test requires the '_' separator, or 'corenode_modules' would
# satisfy a declared 'node_modules'.
assert_eq "T-BK-17 near-miss suffix is NOT accepted" "mismatch" \
    "$(bk volume:node_modules volume:corenode_modules)"
assert_eq "T-BK-18 healthy bind/bind" "match" "$(bk bind bind)"
assert_eq "T-BK-19 healthy tmpfs/tmpfs" "match" "$(bk tmpfs tmpfs)"

# --- End to end: the exact false-clean, through the real checker -----------
# Reproduced against a live healthy container before the fix: rewriting this
# one mountinfo line made the checker report "167 mounted ... 0 findings",
# exit 0. The destination-set diff still says 0 MISSING here, which is the
# point -- only the backing check can see it.
sed 's|^8 1 254:1 /docker/volumes/testproj_native-seed-core-better-sqlite3/_data |8 1 0:43 /host/core/better-sqlite3 |; s|master:1 - ext4 /dev/vda1 rw,discard|- virtiofs virtiofs0 rw|' \
    "$WORK/mountinfo-clean" >"$WORK/mountinfo-substituted"
assert_eq "T-SUB-0 fixture actually differs from the clean one" "1" \
    "$(diff "$WORK/mountinfo-clean" "$WORK/mountinfo-substituted" | grep -c '^> ' || true)"
out_sub="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-substituted" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-SUB-1 destination-set diff alone still reports 0 MISSING (the false clean)" \
    "MISSING: 0" "$out_sub"
assert_contains "T-SUB-2 backing check catches the substituted named volume" \
    "is mounted but SUBSTITUTED: declared named volume native-seed-core-better-sqlite3 but backed by bind" "$out_sub"
assert_contains "T-SUB-3 the finding names the declaration and the observed root" \
    "root=/host/core/better-sqlite3" "$out_sub"
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-substituted" --link-map "$WORK/linkmap-a2.tsv" \
    --no-report --quiet --strict >/dev/null 2>&1
assert_eq "T-SUB-4 substitution is blocking under --strict" "1" "$?"

# A bind replaced by a named volume is the same class in the other direction:
# the container would read an empty/stale volume where the host tree belongs.
sed 's|^5 1 0:43 /host/core /packages/core/node_modules |5 1 254:1 /docker/volumes/x_stray/_data /packages/core/node_modules |' \
    "$WORK/mountinfo-clean" >"$WORK/mountinfo-volsub"
out_volsub="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-volsub" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-SUB-5 bind declared but a volume mounted is reported" \
    "declared a host bind but backed by volume:x_stray" "$out_volsub"

# ===========================================================================
# A4 SEED REFERENCE + STALE-SEED COMPARISON (finding 4).
#
# Layouts are [DERIVED] from the Dockerfile and confirmed present at runtime.
# MC_NATIVE_SEED_ROOT lets this run against a fixture instead of /opt.
# ===========================================================================
SEED="$WORK/seedroot"
mkdir -p "$SEED/tier-b/node_modules/@turbo/linux-arm64" "$SEED/core-better-sqlite3" \
    "$SEED/better-sqlite3" "$SEED/@esbuild/linux-arm64"
# NOT a subshell: assert_eq mutates pass_n/fail_n, and a subshell would discard
# every one of these results while still printing PASS -- a vacuous test block.
#
# Exported, not a bare assignment: mc_seed_reference reads it, and shellcheck
# cannot see through a sourced function, so a plain assignment is SC2034
# ("appears unused") and fails the `shellcheck -S warning` gate in
# .github/workflows/validate-hooks.yml. It is genuinely consumed externally.
export MC_NATIVE_SEED_ROOT="$SEED"
assert_eq "T-SEED-1 tier-b path maps to tier-b/<repo-relative path>" \
    "$SEED/tier-b/node_modules/@turbo/linux-arm64" \
    "$(mc_seed_reference /app/node_modules/@turbo/linux-arm64 /app)"
assert_eq "T-SEED-2 per-package Tier-A maps to <pkg>-<module>" \
    "$SEED/core-better-sqlite3" \
    "$(mc_seed_reference /app/packages/core/node_modules/better-sqlite3 /app)"
assert_eq "T-SEED-3 root Tier-A maps to <module>" "$SEED/better-sqlite3" \
    "$(mc_seed_reference /app/node_modules/better-sqlite3 /app)"
assert_eq "T-SEED-4 @-scope seed dir is found (it just has no package.json)" \
    "$SEED/@esbuild" "$(mc_seed_reference /app/node_modules/@esbuild /app)"
assert_eq "T-SEED-5 no seed reference yields EMPTY, never a guess" "" \
    "$(mc_seed_reference /app/packages/core/node_modules /app)"
assert_eq "T-SEED-6 out-of-scope destination yields empty" "" \
    "$(mc_seed_reference /elsewhere/node_modules/foo /app)"
unset MC_NATIVE_SEED_ROOT

# End to end: a mounted named-volume target holding an OLDER version than the
# image seed. This is reachable in production, not hypothetical -- both boot
# seeders gate on `[ -f "$target/package.json" ]`, so a volume that already
# holds any copy is never re-seeded after a dependency bump.
VOLDST="$WORK/seedlive/node_modules/better-sqlite3"
mkdir -p "$VOLDST" "$SEED/better-sqlite3"
printf '{"name":"better-sqlite3","version":"11.10.0"}' >"$SEED/better-sqlite3/package.json"
printf '{"name":"better-sqlite3","version":"11.9.0"}' >"$VOLDST/package.json"
# Build the ELF for THIS kernel's e_machine, or A4's architecture arm would add
# an unrelated finding on any host that is not aarch64 -- a test that only
# passes on the machine it was written on is not a test.
case "$(uname -m)" in
    aarch64 | arm64) elf_machine='\267\000' ;;
    x86_64 | amd64) elf_machine='\076\000' ;;
    *) elf_machine='\000\000' ;;
esac
# shellcheck disable=SC2059  # the machine bytes are a deliberate format insert
printf "\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\003\000$elf_machine" \
    >"$VOLDST/better_sqlite3.node"
cat >"$WORK/compose-seed.yml" <<YML
services:
  dev:
    volumes:
      - native-seed-better-sqlite3:$WORK/seedlive/node_modules/better-sqlite3
YML
{
    echo "1 0 0:1 / / rw,relatime - overlay overlay rw"
    echo "2 1 254:1 /docker/volumes/p_native-seed-better-sqlite3/_data $VOLDST rw,relatime master:1 - ext4 /dev/vda1 rw,discard"
} >"$WORK/mountinfo-seed"
out_stale="$(MC_NATIVE_SEED_ROOT="$SEED" bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-seed.yml" --mountinfo "$WORK/mountinfo-seed" \
    --scope "$WORK/seedlive" --live --no-report 2>&1)"

# --- PRECONDITIONS, tested DIRECTLY -----------------------------------------
# Not `uname`, not `[ -d /opt/native-seed ]`, not "is this Linux". A platform
# string is an INFERENCE about what the block needs; these are the properties
# themselves, checked by running them. (The coordinator's reading of the host
# failure -- "/proc/self/mountinfo and /opt/native-seed are absent" -- does not
# survive this test: neither is consulted here, because --mountinfo and
# MC_NATIVE_SEED_ROOT are both supplied. Measured: the real cause was the /var
# symlink, now fixed at $WORK. These guards remain as the honest gate.)
seed_skip=""
if [ -z "$(MC_NATIVE_SEED_ROOT="$SEED" mc_seed_reference "$VOLDST" "$WORK/seedlive")" ]; then
    seed_skip="no image seed reference resolves for the fixture target under MC_NATIVE_SEED_ROOT=$SEED"
elif ! printf '%s\n' "$out_stale" | grep -q 'MISSING: 0'; then
    seed_skip="the checker does not observe the fixture destination as mounted (declared $VOLDST resolves to $(mc_resolve_container_path "$VOLDST")), so the mounted-only comparison cannot run"
fi

if [ -n "$seed_skip" ]; then
    # Name the absent precondition AND what was therefore never asserted, once
    # per assertion, so "ran" and "did not run" stay countable. T-SEED-10 skips
    # WITH the others rather than passing on an empty output -- that spurious
    # green is the whole reason this guard exists.
    for t in \
        "T-SEED-7 an ABI-CORRECT but STALE seed is reported" \
        "T-SEED-8 the finding names both versions" \
        "T-SEED-9 version comparison reports its denominator" \
        "T-SEED-10 a matching version yields a stale count of exactly 0" \
        "T-SEED-11 matching version still reports the denominator" \
        "T-SEED-12 no seed reference => NOT EVALUATED, not a silent pass"; do
        skip_test A4 "$t" "$seed_skip -- the stale-seed comparison was NOT asserted"
    done
    echo "     [T-SEED e2e] 0 of 6 assertions ran, 6 skipped"
else
    assert_contains "T-SEED-7 an ABI-CORRECT but STALE seed is reported" \
        "STALE SEED" "$out_stale"
    assert_contains "T-SEED-8 the finding names both versions" \
        "holds version 11.9.0 but the image seed" "$out_stale"
    assert_contains "T-SEED-9 version comparison reports its denominator" \
        "seeded version compared against the image seed for 1 mounted target(s); 1 stale" "$out_stale"
    # The negative case -- what separates a working comparison from one that
    # fires on everything. Stated POSITIVELY: extract the stale count and
    # require it to be exactly 0. An assert_not_contains here would pass on an
    # empty string, i.e. whenever the comparison never ran, which is precisely
    # the vacuous-success shape this checker exists to eliminate (measured: it
    # did exactly that on the macOS host, 5 reds and 1 spurious green).
    printf '{"name":"better-sqlite3","version":"11.10.0"}' >"$VOLDST/package.json"
    out_fresh="$(MC_NATIVE_SEED_ROOT="$SEED" bash "$CHECKER" --root "$WORK" --mode worktree \
        --compose "$WORK/compose-seed.yml" --mountinfo "$WORK/mountinfo-seed" \
        --scope "$WORK/seedlive" --live --no-report 2>&1)"
    fresh_stale_count="$(printf '%s\n' "$out_fresh" |
        sed -n 's/.*mounted target(s); \([0-9][0-9]*\) stale.*/\1/p' | head -1)"
    assert_eq "T-SEED-10 a matching version yields a stale count of exactly 0" \
        "0" "$fresh_stale_count"
    assert_contains "T-SEED-11 matching version still reports the denominator" \
        "for 1 mounted target(s); 0 stale" "$out_fresh"
    # A destination with no resolvable seed reference is COUNTED, never asserted.
    out_noref="$(MC_NATIVE_SEED_ROOT="$WORK/emptyseed" bash "$CHECKER" --root "$WORK" \
        --mode worktree --compose "$WORK/compose-seed.yml" --mountinfo "$WORK/mountinfo-seed" \
        --scope "$WORK/seedlive" --live --no-report 2>&1)"
    assert_contains "T-SEED-12 no seed reference => NOT EVALUATED, not a silent pass" \
        "NOT EVALUATED [A4] seeded-version comparison ran on 0 target(s) (1 had no resolvable image seed reference)" "$out_noref"
    echo "     [T-SEED e2e] 6 of 6 assertions ran, 0 skipped"
fi

# ===========================================================================
# ADR-151 -- a ZERO DENOMINATOR is not a pass (finding 2).
#
# Each case below reproduced `ok [A2] all 0 in-scope declared destinations are
# mounted` + exit 0 UNDER --strict before the fix.
# ===========================================================================
out_nosvc="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --service nosuch --no-report 2>&1)"
assert_not_contains "T-NE-1 --service nosuch no longer prints an 'all 0 ... mounted' pass" \
    "ok   [A2] all 0" "$out_nosvc"
assert_contains "T-NE-2 --service nosuch reports A1 not evaluated, naming the service" \
    "NOT EVALUATED [A1] no volume entries parsed for service 'nosuch'" "$out_nosvc"
assert_contains "T-NE-3 --service nosuch reports A2 not evaluated" \
    "NOT EVALUATED [A2] 0 of 0 declared destination(s) fall within scope" "$out_nosvc"
assert_contains "T-NE-4 the summary names the not-evaluated count" \
    "0 finding(s), 4 not evaluated" "$out_nosvc"
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-clean" --link-map "$WORK/linkmap-a2.tsv" \
    --service nosuch --no-report --quiet --strict >/dev/null 2>&1
assert_eq "T-NE-5 a zero denominator is BLOCKING under --strict" "1" "$?"
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-clean" --link-map "$WORK/linkmap-a2.tsv" \
    --service nosuch --no-report --quiet >/dev/null 2>&1
assert_eq "T-NE-6 ...but still warn-only without --strict (D-20)" "0" "$?"

# Declarations exist, but none are inside --scope: a different zero denominator
# with a different cause, and it must say so rather than reuse A1's message.
out_oos="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --scope /nowhere --no-report 2>&1)"
assert_contains "T-NE-7 out-of-scope declarations report A2 not evaluated with the real count" \
    "NOT EVALUATED [A2] 0 of 7 declared destination(s) fall within scope /nowhere" "$out_oos"
assert_not_contains "T-NE-8 ...and do NOT also claim A1 was empty" \
    "NOT EVALUATED [A1]" "$out_oos"

# A6's mode check used to print NOTHING when no :ro destination was declared,
# which reads identically to a clean run.
cat >"$WORK/compose-noro.yml" <<'YML'
services:
  dev:
    volumes:
      - /host/nm/.vite:/app/node_modules/.vite
YML
out_noro="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-noro.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --no-report 2>&1)"
assert_contains "T-NE-9 A6 with no :ro declarations says so instead of staying silent" \
    "NOT EVALUATED [A6] 0 declared destination(s) carry the :ro option" "$out_noro"

# A4 with --live but no named-volume target: the ABI probe ran and asserted on
# nothing. `ok ... asserted on 0 native binaries` is the vacuous form.
out_a4empty="$(bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-noro.yml" --mountinfo "$WORK/mountinfo-clean" \
    --link-map "$WORK/linkmap-a2.tsv" --live --no-report 2>&1)"
assert_contains "T-NE-10 A4 asserting on 0 binaries is NOT EVALUATED, not ok" \
    "NOT EVALUATED [A4] asserted on 0 native binaries" "$out_a4empty"
assert_not_contains "T-NE-11 ...and never prints an 'ok' for 0 binaries" \
    "ok   [A4] asserted on 0" "$out_a4empty"

# A deliberate flag-level opt-out is a SKIP, not an empty denominator: it is
# reported, but it must not block under --strict.
assert_contains "T-NE-12 --live omitted is reported as SKIP, not ok" \
    "SKIP [A4] --live not set" "$out_clean"
assert_not_contains "T-NE-13 a flag SKIP is not counted as NOT EVALUATED" \
    "NOT EVALUATED" "$out_clean"
bash "$CHECKER" --root "$WORK" --mode worktree --compose "$WORK/compose-a2.yml" \
    --mountinfo "$WORK/mountinfo-clean" --link-map "$WORK/linkmap-a2.tsv" \
    --no-report --quiet --strict >/dev/null 2>&1
assert_eq "T-NE-14 a flag SKIP does not block under --strict" "0" "$?"

# ===========================================================================
# REPORT KEY -- one file per container, so a healthy container cannot erase a
# degraded fleet's findings (finding 1).
#
# docker-compose.yml:100 binds ${HOME}/.skillsmith into EVERY dev container and
# :113 sets SKILLSMITH_STATE_DIR_OVERRIDE, so the previous single fixed path
# was written by all of them. MEASURED on this machine: 18 dev containers, 11
# with the nested per-package mounts detached.
# ===========================================================================
assert_eq "T-KEY-1 key derives from the scope mount's HOST path" \
    "williamsmith-Documents-GitHub-Smith-Horn-skillsmith-.worktrees-smi-6516" \
    "$(mc_report_key /williamsmith/Documents/GitHub/Smith-Horn/skillsmith/.worktrees/smi-6516 "")"
assert_eq "T-KEY-2 same worktree path => same key (stable across restart AND recreate)" \
    "$(mc_report_key /w/x/.worktrees/a "")" "$(mc_report_key /w/x/.worktrees/a "")"
assert_eq "T-KEY-3 different worktrees => different keys" "different" \
    "$([ "$(mc_report_key /w/x/.worktrees/a "")" = "$(mc_report_key /w/x/.worktrees/b "")" ] && echo same || echo different)"
assert_eq "T-KEY-4 falls back to MC_ROOT when no scope mount is visible" "w-repo" \
    "$(mc_report_key "" /w/repo)"
assert_eq "T-KEY-5 explicit override wins" "pinned" \
    "$(SKILLSMITH_MOUNT_COMPOSITION_REPORT_KEY=pinned mc_report_key /w/x /y)"
longpath="/$(printf 'abcdefghij%.0s' $(seq 1 40))"
longkey="$(mc_report_key "$longpath" "")"
assert_eq "T-KEY-6 an over-long key is bounded" "bounded" \
    "$([ "${#longkey}" -le 150 ] && echo bounded || echo "unbounded:${#longkey}")"
assert_contains "T-KEY-7 a truncated key carries a digest so tails cannot collide" \
    "trunc-" "$longkey"

# --- The actual regression: two containers, one file each ------------------
# Two mountinfo fixtures identical except for the /app mount's HOST ROOT --
# i.e. two different worktrees' containers, exactly the fleet shape. The
# DEGRADED one runs first and the HEALTHY one second, which is the ordering
# that erased everything before this fix.
RPTDIR="$WORK/state"
mk_scoped_mountinfo() { # <hostroot> <outfile> <extra-lines-file>
    {
        echo "1 0 0:1 / / rw,relatime - overlay overlay rw"
        echo "2 1 0:43 $1 /app rw,nosuid,nodev,relatime - virtiofs virtiofs0 rw"
        cat "$3"
    } >"$2"
}
grep -v ' /app ' "$WORK/mountinfo-clean" | tail -n +2 >"$WORK/mi-tail-clean"
grep -v ' /app ' "$WORK/mountinfo-a2" | tail -n +2 >"$WORK/mi-tail-degraded"
mk_scoped_mountinfo /host/worktree-degraded "$WORK/mi-c1" "$WORK/mi-tail-degraded"
mk_scoped_mountinfo /host/worktree-healthy "$WORK/mi-c2" "$WORK/mi-tail-clean"

SKILLSMITH_STATE_DIR_OVERRIDE="$RPTDIR" bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mi-c1" \
    --link-map "$WORK/linkmap-a2.tsv" --quiet >/dev/null 2>&1
SKILLSMITH_STATE_DIR_OVERRIDE="$RPTDIR" bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mi-c2" \
    --link-map "$WORK/linkmap-a2.tsv" --quiet >/dev/null 2>&1

assert_eq "T-FLEET-1 two containers write two reports, not one" "2" \
    "$(find "$RPTDIR/mount-composition" -maxdepth 1 -name '*.json' -type f 2>/dev/null | grep -c . || true)"
degraded_rpt="$(cat "$RPTDIR/mount-composition/host-worktree-degraded.json" 2>/dev/null || echo MISSING)"
healthy_rpt="$(cat "$RPTDIR/mount-composition/host-worktree-healthy.json" 2>/dev/null || echo MISSING)"
assert_contains "T-FLEET-2 the DEGRADED container's findings survive the healthy run" \
    '"missing":2' "$degraded_rpt"
assert_contains "T-FLEET-3 ...and still name the destinations" \
    '/packages/core/node_modules/.astro' "$degraded_rpt"
assert_contains "T-FLEET-4 the healthy container's own report is separate and clean" \
    '"missing":0' "$healthy_rpt"
assert_contains "T-FLEET-5 the report is attributable to a worktree, not just a container" \
    '"scope_host_path":"/host/worktree-degraded"' "$degraded_rpt"
assert_contains "T-FLEET-6 the report names its key" \
    '"report_key":"host-worktree-degraded"' "$degraded_rpt"
assert_contains "T-FLEET-7 the report carries the not-evaluated count" \
    '"not_evaluated":' "$degraded_rpt"
assert_contains "T-FLEET-8 the report carries the backing-check denominator" \
    '"backing_checked":' "$degraded_rpt"

# Re-running the SAME container must overwrite its OWN file, not add another --
# otherwise the directory grows once per run rather than once per worktree.
SKILLSMITH_STATE_DIR_OVERRIDE="$RPTDIR" bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mi-c1" \
    --link-map "$WORK/linkmap-a2.tsv" --quiet >/dev/null 2>&1
assert_eq "T-FLEET-9 a repeat run reuses its own key (no per-run accumulation)" "2" \
    "$(find "$RPTDIR/mount-composition" -maxdepth 1 -name '*.json' -type f 2>/dev/null | grep -c . || true)"

# Bounded-ness: a retired worktree stops rewriting its report, so stale files
# must age out rather than accumulate forever.
touch -d '30 days ago' "$RPTDIR/mount-composition/retired-worktree.json" 2>/dev/null ||
    touch -t "$(date -v-30d +%Y%m%d0000 2>/dev/null || echo 200001010000)" \
        "$RPTDIR/mount-composition/retired-worktree.json"
SKILLSMITH_STATE_DIR_OVERRIDE="$RPTDIR" bash "$CHECKER" --root "$WORK" --mode worktree \
    --compose "$WORK/compose-a2.yml" --mountinfo "$WORK/mi-c1" \
    --link-map "$WORK/linkmap-a2.tsv" --quiet >/dev/null 2>&1
assert_eq "T-FLEET-10 a report older than the TTL is pruned" "absent" \
    "$([ -f "$RPTDIR/mount-composition/retired-worktree.json" ] && echo present || echo absent)"
assert_eq "T-FLEET-11 ...and current reports are NOT pruned" "2" \
    "$(find "$RPTDIR/mount-composition" -maxdepth 1 -name '*.json' -type f 2>/dev/null | grep -c . || true)"
assert_eq "T-FLEET-12 no .tmp leftovers from the atomic publish" "0" \
    "$(find "$RPTDIR/mount-composition" -maxdepth 1 -name '*.tmp.*' 2>/dev/null | grep -c . || true)"

echo
echo "-----------------------------------------------------------"
echo "check-mount-composition: $pass_n passed, $fail_n failed, $skip_n skipped (denominator: $((pass_n + fail_n + skip_n)))"
[ "$skip_n" -eq 0 ] ||
    echo "  NOTE: $skip_n assertion(s) were SKIPPED because a precondition was absent -- see the SKIP lines above for which one and what went unasserted."
[ "$fail_n" -eq 0 ] || exit 1
