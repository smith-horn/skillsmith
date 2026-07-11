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
  parseBashArray,
  parseDockerfileRebuildLine,
  parseQuotedSpaceSeparatedVar,
  parseDockerfileStashLoopModules,
  flatOnly,
} from './docker-entrypoint-native-rebuild.helpers.js'

// ---------------------------------------------------------------------------
// Load files once
// ---------------------------------------------------------------------------

let entrypointSrc: string
let dockerfileSrc: string
let libSrc: string
let regenLockfileSrc: string

beforeAll(() => {
  entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
  dockerfileSrc = readFileSync(DOCKERFILE_PATH, 'utf8')
  libSrc = readFileSync(LIB_SH_PATH, 'utf8')
  regenLockfileSrc = readFileSync(REGEN_LOCKFILE_PATH, 'utf8')
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
  function extractValidateNativeModuleBody(src: string): string {
    const startIdx = src.indexOf('validate_native_module() {')
    expect(startIdx, 'validate_native_module() definition not found').toBeGreaterThan(-1)
    const endIdx = src.indexOf('\n}', startIdx)
    expect(endIdx, 'closing brace for validate_native_module() not found').toBeGreaterThan(-1)
    return src.slice(startIdx, endIdx)
  }

  it('better-sqlite3 gets a rigorous check — NOT a bare require() (the exact discovery-#3 false green)', () => {
    const body = extractValidateNativeModuleBody(entrypointSrc)
    const caseStart = body.indexOf('better-sqlite3)')
    expect(caseStart, 'better-sqlite3) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', caseStart)
    const caseBody = body.slice(caseStart, caseEnd)
    expect(caseBody).toMatch(/new\s*\(require\('better-sqlite3'\)\)\(':memory:'\)\.close\(\)/)
    // The false green this fix closes: a bare require() with no instantiation.
    expect(caseBody).not.toMatch(/^\s*node -e "require\('better-sqlite3'\)"\s*2>\/dev\/null\s*$/m)
  })

  it('esbuild and @esbuild share a rigorous transformSync() check — NOT a bare require()', () => {
    const body = extractValidateNativeModuleBody(entrypointSrc)
    const caseStart = body.indexOf('esbuild | @esbuild)')
    expect(caseStart, 'esbuild | @esbuild) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', caseStart)
    const caseBody = body.slice(caseStart, caseEnd)
    expect(caseBody).toMatch(/require\('esbuild'\)\.transformSync\('1'\)/)
  })

  it('the default branch keeps the bare require() check — sufficient for onnxruntime-node/hnswlib-node (both dlopen() at require() time, confirmed live)', () => {
    const body = extractValidateNativeModuleBody(entrypointSrc)
    const defaultCaseStart = body.indexOf('*)')
    expect(defaultCaseStart, 'default *) case branch not found').toBeGreaterThan(-1)
    const caseEnd = body.indexOf(';;', defaultCaseStart)
    const caseBody = body.slice(defaultCaseStart, caseEnd)
    expect(caseBody).toMatch(/node -e "require\('\$1'\)" 2>\/dev\/null/)
  })

  it("all three of validate_native_module's call sites use the function, not an inline require() (would silently bypass the dispatch)", () => {
    const bareRequireChecks =
      entrypointSrc.match(/node -e "require\('\$\{?module\}?'\)" 2>\/dev\/null/g) ?? []
    // The ONLY bare `require('${module}')`/`require('$module')` check outside
    // validate_native_module's own default branch would indicate a call site
    // bypassing the dispatch — none should exist.
    const body = extractValidateNativeModuleBody(entrypointSrc)
    const outsideFunction = entrypointSrc.replace(body, '')
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
