/**
 * SMI-5650 Wave 2 extension of docker-entrypoint-native-rebuild.test.ts's
 * static-assertion suite (split into its own file per CLAUDE.md's 500-line
 * guidance — see the sibling file's header for the original C1/L15/#5
 * assertions and shared parsing-helper sanity checks).
 *
 * Assertions:
 *   C2 (extended) — The NATIVE_MODULES canonical list stays in sync with
 *        scripts/_lib.sh's NATIVE_MODULES_FOR_OVERLAY, the Dockerfile's
 *        /opt/native-seed stash loop, AND scripts/regen-lockfile.sh's
 *        NATIVE_MODULES string. This is the exact class of drift that let a
 *        pre-existing esbuild gap ship undetected in regen-lockfile.sh (H3).
 *   C2 (further extended) — `@esbuild` (a scope directory added as a 5th
 *        NATIVE_MODULES / NATIVE_MODULES_FOR_OVERLAY entry — esbuild's own
 *        JS package does not ship the native binary it spawns; that lives
 *        in the separate `@esbuild/<platform>-<arch>` package) is
 *        intentionally ASYMMETRIC across these lists: present in
 *        NATIVE_MODULES / NATIVE_MODULES_FOR_OVERLAY (both drive the
 *        volume-reference / tmpfs-declaration mechanism, which needs to
 *        know about the scope), but deliberately absent from the
 *        Dockerfile's `RUN npm rebuild …` line, the Dockerfile's flat
 *        stash loop, and regen-lockfile.sh's NATIVE_MODULES — none of which
 *        can meaningfully target a bare scope directory. A dedicated
 *        describe block asserts the asymmetry explicitly so a future
 *        accidental addition (or accidental removal of the Dockerfile's
 *        separate @esbuild stash block) fails loudly.
 *   validate_native_module dispatch — locks in the per-module validation
 *        dispatch (SMI-5650 amendment review High finding): a bare
 *        `require('<module>')` is a false green for better-sqlite3/esbuild
 *        (both load/spawn their native binary lazily, not at require()
 *        time — confirmed live by deliberately corrupting better-sqlite3
 *        and observing the boot-time validation loop print a false "✓" for
 *        it). This is the subtlest of the three Wave 2 discoveries and the
 *        one a future refactor is most likely to silently regress.
 */
import { readFileSync } from 'fs'
import { describe, expect, it, beforeAll } from 'vitest'
import {
  ENTRYPOINT_PATH,
  DOCKERFILE_PATH,
  LIB_SH_PATH,
  REGEN_LOCKFILE_PATH,
  NATIVE_PER_PACKAGE_PATH,
  parseBashArray,
  parseDockerfileRebuildLine,
  parseQuotedSpaceSeparatedVar,
  parseDockerfileStashLoopModules,
  flatOnly,
} from './docker-entrypoint-native-rebuild.helpers.js'
import { extractPackageBootTimeSeedBlock } from './docker-entrypoint-native-seed-smi5784.helpers.js'

// ---------------------------------------------------------------------------
// Load files once
// ---------------------------------------------------------------------------

let entrypointSrc: string
let dockerfileSrc: string
let libSrc: string
let regenLockfileSrc: string
// SMI-5784 file-length split: validate_native_module() and the per-package
// boot-time seed step this file cross-checks now live in this sourced
// sibling, not docker-entrypoint.sh itself.
let nativePerPackageSrc: string

beforeAll(() => {
  entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
  dockerfileSrc = readFileSync(DOCKERFILE_PATH, 'utf8')
  libSrc = readFileSync(LIB_SH_PATH, 'utf8')
  regenLockfileSrc = readFileSync(REGEN_LOCKFILE_PATH, 'utf8')
  nativePerPackageSrc = readFileSync(NATIVE_PER_PACKAGE_PATH, 'utf8')
})

// ---------------------------------------------------------------------------
// C2 (extended, SMI-5650 Wave 2 / H3): the same NATIVE_MODULES canonical list
// must also stay in sync with scripts/_lib.sh's NATIVE_MODULES_FOR_OVERLAY,
// the Dockerfile's /opt/native-seed stash loop, AND scripts/regen-lockfile.sh's
// NATIVE_MODULES string. This is the exact class of drift that let a
// pre-existing esbuild gap ship undetected in regen-lockfile.sh — extending
// the sync-check to that file closes the gap the original C2 test didn't
// cover (plan §6 item 5's explicit "consider whether to extend" call, taken).
// ---------------------------------------------------------------------------

describe('C2 (extended, SMI-5650 Wave 2): NATIVE_MODULES sync across _lib.sh, Dockerfile stash, and regen-lockfile.sh', () => {
  it('scripts/_lib.sh NATIVE_MODULES_FOR_OVERLAY is present and non-empty', () => {
    const overlayModules = parseBashArray(libSrc, 'NATIVE_MODULES_FOR_OVERLAY')
    expect(overlayModules).not.toBeNull()
    expect(overlayModules!.size).toBeGreaterThan(0)
  })

  it('Dockerfile contains a parseable /opt/native-seed stash loop (`for module in … ; do`)', () => {
    const stashModules = parseDockerfileStashLoopModules(dockerfileSrc)
    expect(stashModules).not.toBeNull()
    expect(stashModules!.size).toBeGreaterThan(0)
  })

  it('scripts/regen-lockfile.sh NATIVE_MODULES is present and non-empty', () => {
    const regenModules = parseQuotedSpaceSeparatedVar(regenLockfileSrc, 'NATIVE_MODULES')
    expect(regenModules).not.toBeNull()
    expect(regenModules!.size).toBeGreaterThan(0)
  })

  it('scripts/_lib.sh NATIVE_MODULES_FOR_OVERLAY equals docker-entrypoint.sh NATIVE_MODULES (set equality)', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const overlayModules = parseBashArray(libSrc, 'NATIVE_MODULES_FOR_OVERLAY')

    expect(nativeModules).not.toBeNull()
    expect(overlayModules).not.toBeNull()

    const nativeArr = [...nativeModules!].sort()
    const overlayArr = [...overlayModules!].sort()

    expect(
      overlayArr,
      `scripts/_lib.sh NATIVE_MODULES_FOR_OVERLAY [${overlayArr.join(', ')}] must equal docker-entrypoint.sh NATIVE_MODULES [${nativeArr.join(', ')}]`
    ).toEqual(nativeArr)
  })

  it('Dockerfile stash loop module list equals docker-entrypoint.sh NATIVE_MODULES flat (non-scope) entries (set equality) — @esbuild is intentionally excluded from the flat loop: it has its own SEPARATE stash RUN block (see the C2-asymmetry describe block below), not a loop iteration, since a bare scope directory cannot be validated the same way the loop validates its flat entries', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const stashModules = parseDockerfileStashLoopModules(dockerfileSrc)

    expect(nativeModules).not.toBeNull()
    expect(stashModules).not.toBeNull()

    const nativeArr = flatOnly(nativeModules!)
    const stashArr = [...stashModules!].sort()

    expect(
      stashArr,
      `Dockerfile /opt/native-seed stash loop [${stashArr.join(', ')}] must equal docker-entrypoint.sh NATIVE_MODULES flat entries [${nativeArr.join(', ')}]`
    ).toEqual(nativeArr)
  })

  it('scripts/regen-lockfile.sh NATIVE_MODULES equals docker-entrypoint.sh NATIVE_MODULES flat (non-scope) entries (set equality) — the esbuild-gap regression class (H3); @esbuild is intentionally excluded (see the C2-asymmetry describe block below)', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const regenModules = parseQuotedSpaceSeparatedVar(regenLockfileSrc, 'NATIVE_MODULES')

    expect(nativeModules).not.toBeNull()
    expect(regenModules).not.toBeNull()

    const nativeArr = flatOnly(nativeModules!)
    const regenArr = [...regenModules!].sort()

    expect(
      regenArr,
      `scripts/regen-lockfile.sh NATIVE_MODULES [${regenArr.join(', ')}] must equal docker-entrypoint.sh NATIVE_MODULES flat entries [${nativeArr.join(', ')}] — a mismatch here is exactly the pre-existing esbuild gap this test was added to catch`
    ).toEqual(nativeArr)
  })

  it('known modules (better-sqlite3, onnxruntime-node, esbuild, hnswlib-node) are present in _lib.sh, the Dockerfile stash, and regen-lockfile.sh', () => {
    const overlayModules = parseBashArray(libSrc, 'NATIVE_MODULES_FOR_OVERLAY')
    const stashModules = parseDockerfileStashLoopModules(dockerfileSrc)
    const regenModules = parseQuotedSpaceSeparatedVar(regenLockfileSrc, 'NATIVE_MODULES')

    expect(overlayModules).not.toBeNull()
    expect(stashModules).not.toBeNull()
    expect(regenModules).not.toBeNull()

    const expected = ['better-sqlite3', 'onnxruntime-node', 'esbuild', 'hnswlib-node']
    for (const mod of expected) {
      expect(
        overlayModules!.has(mod),
        `scripts/_lib.sh NATIVE_MODULES_FOR_OVERLAY missing: ${mod}`
      ).toBe(true)
      expect(stashModules!.has(mod), `Dockerfile stash loop missing: ${mod}`).toBe(true)
      expect(
        regenModules!.has(mod),
        `scripts/regen-lockfile.sh NATIVE_MODULES missing: ${mod}`
      ).toBe(true)
    }
  })

  it("the boot-time seed step's inline module list matches NATIVE_MODULES (SMI-5650 amendment review Low finding — this list is hardcoded separately since NATIVE_MODULES is declared later in the file, below the dist check; drift here is self-healing via VALIDATION_FAILED but should still fail loudly)", () => {
    const bootTimeModules = parseDockerfileStashLoopModules(entrypointSrc)
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(bootTimeModules, 'boot-time seed step for-loop not found').not.toBeNull()
    expect(nativeModules).not.toBeNull()
    expect([...bootTimeModules!].sort()).toEqual([...nativeModules!].sort())
  })
})

// ---------------------------------------------------------------------------
// C2 (extended, SMI-5784): the exact-set-equality drift check above already
// proves the ROOT lists stay in sync. SMI-5784 added a SECOND, independent
// copy of two of those lists — the per-package boot-time seed step's inline
// module list in docker-entrypoint.sh, and the per-package flat stash
// loop's module list in the Dockerfile — which could each independently
// drift from NATIVE_MODULES / NATIVE_MODULES_FOR_OVERLAY without the checks
// above ever noticing (they only see the FIRST "for module in …; do"
// occurrence in each file, i.e. the ROOT loop). This block extends the SAME
// exact-set-equality technique to those two per-package lists, rather than
// adding a separate, weaker grep-only convention check (plan doc § 5:
// "reviewer found the existing structural test is already stronger than
// what this doc originally proposed... do not regress it").
// ---------------------------------------------------------------------------

describe('C2 (extended, SMI-5784): per-package module lists stay in sync with NATIVE_MODULES', () => {
  it("the PER-PACKAGE boot-time seed step's inline module list matches NATIVE_MODULES (SMI-5784 — a second, independent copy of the same list the SMI-5650 test above already checks for the root loop)", () => {
    // SMI-5784 file-length split: the per-package boot-time seed step now
    // lives in docker-entrypoint-native-per-package.sh, not
    // docker-entrypoint.sh — extracted from that file's source instead.
    const packageBootBlock = extractPackageBootTimeSeedBlock(nativePerPackageSrc)
    const packageBootModules = parseDockerfileStashLoopModules(packageBootBlock)
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(packageBootModules, 'per-package boot-time seed step for-loop not found').not.toBeNull()
    expect(nativeModules).not.toBeNull()
    expect([...packageBootModules!].sort()).toEqual([...nativeModules!].sort())
  })

  it('the Dockerfile PER-PACKAGE flat stash loop module list equals docker-entrypoint.sh NATIVE_MODULES flat (non-scope) entries (set equality) — @esbuild is intentionally excluded from this loop too, same asymmetry rationale as the root flat stash loop (its own separate per-package @esbuild-scope stash block is asserted below)', () => {
    const anchor = '# SMI-5784: PER-PACKAGE stash'
    const anchorIdx = dockerfileSrc.indexOf(anchor)
    expect(anchorIdx, 'SMI-5784 per-package stash anchor not found in Dockerfile').toBeGreaterThan(
      -1
    )
    const packageStashSlice = dockerfileSrc.slice(anchorIdx)
    const packageStashModules = parseDockerfileStashLoopModules(packageStashSlice)
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')

    expect(packageStashModules, 'Dockerfile per-package stash for-loop not found').not.toBeNull()
    expect(nativeModules).not.toBeNull()

    const nativeArr = flatOnly(nativeModules!)
    const packageStashArr = [...packageStashModules!].sort()

    expect(
      packageStashArr,
      `Dockerfile per-package /opt/native-seed stash loop [${packageStashArr.join(', ')}] must equal docker-entrypoint.sh NATIVE_MODULES flat entries [${nativeArr.join(', ')}]`
    ).toEqual(nativeArr)
  })

  it('the Dockerfile has a SEPARATE dedicated per-package @esbuild scope stash block (mirrors the root-level dedicated block asserted in the asymmetry describe block above)', () => {
    expect(dockerfileSrc).toMatch(/mkdir\s+-p\s+"\/opt\/native-seed\/\$\{pkg\}-@esbuild"/)
    expect(dockerfileSrc).toMatch(
      /cp\s+-a\s+"\$\{pkg_dir\}node_modules\/@esbuild\/\."\s+"\/opt\/native-seed\/\$\{pkg\}-@esbuild\/"/
    )
  })
})

// ---------------------------------------------------------------------------
// C2 (further extended, SMI-5650 Wave 2 REVISED): the @esbuild asymmetry is
// intentional, not drift.
//
// @esbuild (a scope directory) is REQUIRED for the tmpfs-seed / volume-
// reference mechanism — docker-entrypoint.sh's NATIVE_MODULES and
// scripts/_lib.sh's NATIVE_MODULES_FOR_OVERLAY both include it (asserted by
// the exact-equality tests above, which already pass). But it is
// deliberately ABSENT from three other lists that operate on installable,
// `npm rebuild`-able packages, none of which apply to a bare scope
// directory: the Dockerfile's `RUN npm rebuild …` line, the Dockerfile's
// flat /opt/native-seed stash loop, and scripts/regen-lockfile.sh's
// NATIVE_MODULES string. The tests above already encode this correctly via
// flatOnly() — this block makes the asymmetry an explicit, named assertion
// so a future edit that either (a) accidentally adds `@esbuild` to one of
// the three flat lists, or (b) silently drops the Dockerfile's separate
// @esbuild stash RUN block, fails loudly here instead of only showing up as
// an unexplained flatOnly() filter.
// ---------------------------------------------------------------------------

describe('C2 (further extended, SMI-5650 Wave 2 REVISED): the @esbuild asymmetry is intentional', () => {
  it('NATIVE_MODULES contains exactly one scope entry, @esbuild', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(nativeModules).not.toBeNull()

    const scopeEntries = [...nativeModules!].filter((m) => m.startsWith('@'))
    expect(scopeEntries).toEqual(['@esbuild'])
  })

  it('scripts/_lib.sh NATIVE_MODULES_FOR_OVERLAY contains exactly one scope entry, @esbuild', () => {
    const overlayModules = parseBashArray(libSrc, 'NATIVE_MODULES_FOR_OVERLAY')
    expect(overlayModules).not.toBeNull()

    const scopeEntries = [...overlayModules!].filter((m) => m.startsWith('@'))
    expect(scopeEntries).toEqual(['@esbuild'])
  })

  it('the Dockerfile `RUN npm rebuild …` line does NOT include @esbuild — `npm rebuild` has no target for a bare scope directory', () => {
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)
    expect(dockerModules).not.toBeNull()
    expect(dockerModules!.has('@esbuild')).toBe(false)
  })

  it('the Dockerfile flat /opt/native-seed stash loop does NOT iterate @esbuild — it has its own dedicated stash RUN block instead', () => {
    const stashModules = parseDockerfileStashLoopModules(dockerfileSrc)
    expect(stashModules).not.toBeNull()
    expect(stashModules!.has('@esbuild')).toBe(false)
  })

  it('the Dockerfile has a SEPARATE dedicated RUN block that stashes the @esbuild scope (mkdir + cp -a + transformSync validation)', () => {
    // This is the structural counterpart to the previous test: @esbuild's
    // absence from the flat stash loop is only correct if this separate
    // block exists to cover it — otherwise the scope would silently never
    // be stashed into /opt/native-seed at all.
    expect(dockerfileSrc).toMatch(/mkdir\s+-p\s+\/opt\/native-seed\/@esbuild/)
    expect(dockerfileSrc).toMatch(
      /cp\s+-a\s+node_modules\/@esbuild\/\.\s+\/opt\/native-seed\/@esbuild\//
    )
    expect(dockerfileSrc).toMatch(/require\('esbuild'\)\.transformSync\('1'\)/)
  })

  it("scripts/regen-lockfile.sh NATIVE_MODULES does NOT include @esbuild — unrelated to that script's purpose (regenerating the lockfile + rebuilding flat native modules via `npm rebuild`, not managing the platform-scope stash)", () => {
    const regenModules = parseQuotedSpaceSeparatedVar(regenLockfileSrc, 'NATIVE_MODULES')
    expect(regenModules).not.toBeNull()
    expect(regenModules!.has('@esbuild')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SMI-5650 amendment review High finding: validate_native_module's per-module
// dispatch is the fix for discovery #3 (a bare `require('<module>')` is a
// false green for better-sqlite3/esbuild, since both dlopen()/spawn their
// real native binary lazily, not at require() time — confirmed live by
// deliberately corrupting better-sqlite3 and observing the boot-time
// validation loop print a false "✓" for it). This is the subtlest of the
// three Wave 2 discoveries and the one a future refactor is most likely to
// silently regress (e.g. "simplifying" the case statement back to a bare
// require() for all four/five modules) — lock in the dispatch shape
// structurally so that regression fails a test instead of silently
// reintroducing the exact bug this fix closed.
// ---------------------------------------------------------------------------
describe('validate_native_module dispatch (SMI-5650 amendment review, High finding)', () => {
  // SMI-5784 file-length split: validate_native_module() (and its own
  // path-aware extension) now lives in docker-entrypoint-native-per-package.sh,
  // not docker-entrypoint.sh — every extraction below reads nativePerPackageSrc
  // instead. docker-entrypoint.sh's own call SITES (the root loop calling
  // `validate_native_module "$module"`) are unaffected and still work via the
  // early `source` line.
  function extractValidateNativeModuleBody(src: string): string {
    const startIdx = src.indexOf('validate_native_module() {')
    expect(startIdx, 'validate_native_module() definition not found').toBeGreaterThan(-1)
    const endIdx = src.indexOf('\n}', startIdx)
    expect(endIdx, 'closing brace for validate_native_module() not found').toBeGreaterThan(-1)
    return src.slice(startIdx, endIdx)
  }

  it('better-sqlite3 gets a rigorous check — NOT a bare require() (the exact discovery-#3 false green)', () => {
    const body = extractValidateNativeModuleBody(nativePerPackageSrc)
    const caseStart = body.indexOf('better-sqlite3)')
    expect(caseStart, 'better-sqlite3) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', caseStart)
    const caseBody = body.slice(caseStart, caseEnd)
    expect(caseBody).toMatch(/new\s*\(require\('better-sqlite3'\)\)\(':memory:'\)\.close\(\)/)
    // The false green this fix closes: a bare require() with no instantiation.
    expect(caseBody).not.toMatch(/^\s*node -e "require\('better-sqlite3'\)"\s*2>\/dev\/null\s*$/m)
  })

  it('esbuild and @esbuild share a rigorous transformSync() check — NOT a bare require()', () => {
    const body = extractValidateNativeModuleBody(nativePerPackageSrc)
    const caseStart = body.indexOf('esbuild | @esbuild)')
    expect(caseStart, 'esbuild | @esbuild) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', caseStart)
    const caseBody = body.slice(caseStart, caseEnd)
    expect(caseBody).toMatch(/require\('esbuild'\)\.transformSync\('1'\)/)
  })

  it('the default branch keeps the bare require() check — sufficient for onnxruntime-node/hnswlib-node (both dlopen() at require() time, confirmed live)', () => {
    const body = extractValidateNativeModuleBody(nativePerPackageSrc)
    // SMI-5784: lastIndexOf, not indexOf — the function body now ALSO
    // contains an earlier `@*)` arm (inside the SMI-5784 path-aware
    // pre-check's own `case "$1" in @*) probe="esbuild" ;; esac`), whose
    // "*)" substring would otherwise be found FIRST by a plain indexOf and
    // misidentified as this test's target. The true top-level default `*)`
    // arm is always the LAST such occurrence in the function body.
    const defaultCaseStart = body.lastIndexOf('*)')
    expect(defaultCaseStart, 'default *) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', defaultCaseStart)
    const caseBody = body.slice(defaultCaseStart, caseEnd)
    expect(caseBody).toMatch(/node -e "require\('\$1'\)" 2>\/dev\/null/)
  })

  it("all three of validate_native_module's call sites use the function, not an inline require() (would silently bypass the dispatch)", () => {
    // SMI-5784: the function now lives in nativePerPackageSrc, but a bypass
    // could in principle be introduced in EITHER file (a rogue inline check
    // in docker-entrypoint.sh's own root loop, or one accidentally left
    // behind in nativePerPackageSrc outside the function itself) — scan the
    // combined text of both files, excluding only the function's own
    // legitimate default-branch definition.
    const combinedSrc = `${entrypointSrc}\n${nativePerPackageSrc}`
    const bareRequireChecks =
      combinedSrc.match(/node -e "require\('\$\{?module\}?'\)" 2>\/dev\/null/g) ?? []
    // The ONLY bare `require('${module}')`/`require('$module')` check outside
    // validate_native_module's own default branch would indicate a call site
    // bypassing the dispatch — none should exist.
    const body = extractValidateNativeModuleBody(nativePerPackageSrc)
    const outsideFunction = combinedSrc.replace(body, '')
    expect(bareRequireChecks.filter((m) => outsideFunction.includes(m))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Parsers sanity-check (unit tests for the two SMI-5650-specific helpers —
// parseBashArray/parseDockerfileRebuildLine's own sanity checks live in the
// sibling docker-entrypoint-native-rebuild.test.ts, the original file that
// introduced them)
// ---------------------------------------------------------------------------

describe('parseQuotedSpaceSeparatedVar (local helper, SMI-5650)', () => {
  it('parses a double-quoted space-separated module string', () => {
    const src = `NATIVE_MODULES="better-sqlite3 onnxruntime-node esbuild hnswlib-node"\n`
    const result = parseQuotedSpaceSeparatedVar(src, 'NATIVE_MODULES')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'better-sqlite3',
      'esbuild',
      'hnswlib-node',
      'onnxruntime-node',
    ])
  })

  it('returns null when the variable is missing', () => {
    expect(parseQuotedSpaceSeparatedVar('OTHER="foo bar"\n', 'NATIVE_MODULES')).toBeNull()
  })

  it('returns null for an empty-string assignment', () => {
    expect(parseQuotedSpaceSeparatedVar('NATIVE_MODULES=""\n', 'NATIVE_MODULES')).toBeNull()
  })
})

describe('parseDockerfileStashLoopModules (local helper, SMI-5650)', () => {
  it('parses a `for module in … ; do \\` loop header inside a multi-line RUN', () => {
    const src = [
      'RUN mkdir -p /opt/native-seed \\',
      '    && for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node; do \\',
      '         echo "$module"; \\',
      '       done',
      '',
    ].join('\n')
    const result = parseDockerfileStashLoopModules(src)
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'better-sqlite3',
      'esbuild',
      'hnswlib-node',
      'onnxruntime-node',
    ])
  })

  it('returns null when no `for module in … ; do` loop header is present', () => {
    const src = 'RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true\n'
    expect(parseDockerfileStashLoopModules(src)).toBeNull()
  })

  it('does not conflate the stash loop header with the sibling RUN npm rebuild line', () => {
    const src = [
      'RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true',
      '',
      'RUN mkdir -p /opt/native-seed \\',
      '    && for module in better-sqlite3 onnxruntime-node; do \\',
      '         echo "$module"; \\',
      '       done',
      '',
    ].join('\n')
    const rebuildResult = parseDockerfileRebuildLine(src)
    const stashResult = parseDockerfileStashLoopModules(src)
    expect(rebuildResult).not.toBeNull()
    expect(stashResult).not.toBeNull()
    // The two parsers must independently pick up their own distinct lists —
    // a deliberately narrower stash-loop fixture here proves they don't
    // silently share state or match the same line.
    expect([...rebuildResult!].sort()).toEqual([
      'better-sqlite3',
      'esbuild',
      'hnswlib-node',
      'onnxruntime-node',
    ])
    expect([...stashResult!].sort()).toEqual(['better-sqlite3', 'onnxruntime-node'])
  })
})
