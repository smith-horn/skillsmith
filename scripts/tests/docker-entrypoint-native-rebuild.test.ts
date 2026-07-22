/**
 * Static-assertion tests for the native-module rebuild loop in docker-entrypoint.sh.
 *
 * These tests assert structural properties of the shell script without running
 * it, mirroring the convention from scripts/tests/audit-standards-parse-bash-array.test.ts.
 *
 * Assertions:
 *   C1 — Scoped to the VALIDATION_FAILED guard region only; within that region:
 *        (a) every NATIVE_MODULES entry is rebuilt with --ignore-scripts=false
 *        (b) no `npm rebuild` appears without --ignore-scripts=false
 *        (c) no `if [ "${module}" = ` carve-out remains
 *   C2 — NATIVE_MODULES (bash array) equals the Dockerfile `RUN npm rebuild …` list.
 *        SMI-5650 Wave 2 extends this to cross-check against scripts/_lib.sh,
 *        the Dockerfile's stash loop, regen-lockfile.sh, and the
 *        validate_native_module() dispatch — see the sibling
 *        docker-entrypoint-native-rebuild-smi5650.test.ts (split out per
 *        CLAUDE.md's 500-line guidance).
 *   #5 — The verbose-hint line carries --ignore-scripts=false
 *   L15 — The rebuild loop is nested inside the VALIDATION_FAILED -eq 1 guard
 *
 * SMI-5351: all native modules must use --ignore-scripts=false in the rebuild
 * loop; plain `npm rebuild` is a no-op under .npmrc ignore-scripts=true.
 *
 * SMI-5650 fix note: extractValidationFailedRegion's if/fi depth counter skips
 * pure-comment lines (`^\s*#`) before testing for the bare words "if"/"fi".
 * Wave 2 added an explanatory comment inside the VALIDATION_FAILED region that
 * legitimately uses "if" twice as English prose ("Falls through to npm rebuild
 * if the seed is missing/stale/absent OR if SKILLSMITH_...") — without the
 * comment skip, that prose line silently desyncs the depth counter and the
 * region never closes (extractValidationFailedRegion returns null), which took
 * every L15/C1 test in this file down with it. Comments are still INCLUDED in
 * the returned region text (only excluded from the depth count itself).
 *
 * SMI-5784 note: the "npm rebuild calls do NOT appear outside the
 * VALIDATION_FAILED guard" test below now strips a SECOND, independent
 * region too — the SMI-5784 per-package validate+rebuild block, which is
 * deliberately a SIBLING section to VALIDATION_FAILED (not nested inside
 * it — see that block's own comment in docker-entrypoint.sh for why:
 * nesting inside `if [ $VALIDATION_FAILED -eq 1 ]` would skip per-package
 * validation whenever every ROOT module happens to validate cleanly). Its
 * own `npm rebuild` call is therefore legitimately outside the ROOT
 * region, gated by its OWN per-target failure detection instead of the
 * root's global flag — the test now recognizes both as legitimate
 * `npm rebuild` locations rather than treating the second one as a stray.
 */
import { readFileSync } from 'fs'
import { describe, expect, it, beforeAll } from 'vitest'
import {
  ENTRYPOINT_PATH,
  DOCKERFILE_PATH,
  NATIVE_PER_PACKAGE_PATH,
  parseBashArray,
  parseDockerfileRebuildLine,
  flatOnly,
  extractValidationFailedRegion,
} from './docker-entrypoint-native-rebuild.helpers.js'
import { extractPackageValidationRebuildBlock } from './docker-entrypoint-native-seed-smi5784.helpers.js'

// ---------------------------------------------------------------------------
// Load files once
// ---------------------------------------------------------------------------

let entrypointSrc: string
let dockerfileSrc: string
let nativePerPackageSrc: string

beforeAll(() => {
  entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
  dockerfileSrc = readFileSync(DOCKERFILE_PATH, 'utf8')
  // SMI-5784 file-length split: the per-package validate+rebuild block this
  // file cross-checks now lives in this sourced sibling, not
  // docker-entrypoint.sh itself.
  nativePerPackageSrc = readFileSync(NATIVE_PER_PACKAGE_PATH, 'utf8')
})

// ---------------------------------------------------------------------------
// L15: The rebuild loop is nested inside the VALIDATION_FAILED -eq 1 guard
// ---------------------------------------------------------------------------

describe('L15: rebuild loop nesting', () => {
  it('the VALIDATION_FAILED -eq 1 guard exists in docker-entrypoint.sh', () => {
    expect(entrypointSrc).toMatch(/if\s+\[\s+\$VALIDATION_FAILED\s+-eq\s+1\s+\]/)
  })

  it('the rebuild loop (for module in "${NATIVE_MODULES[@]}") is inside the VALIDATION_FAILED guard', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()
    // The rebuild for loop must appear within the region
    expect(region).toMatch(/for\s+module\s+in\s+"\$\{NATIVE_MODULES\[@\]\}"/)
  })

  it('npm rebuild calls do NOT appear outside the VALIDATION_FAILED guard OR the SMI-5784 per-package validate+rebuild block', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()
    // SMI-5784 file-length split: the per-package validate+rebuild block now
    // lives in docker-entrypoint-native-per-package.sh, so it's extracted
    // from THAT file's source — it no longer appears in entrypointSrc at
    // all (only a short delegating comment + the function call do), which
    // means entrypointSrc's own "outside the region" text now legitimately
    // contains zero `npm rebuild` occurrences on its own; this still proves
    // the invariant (no stray npm rebuild outside the two known-legitimate
    // regions) without needing packageRegion to literally appear in
    // entrypointSrc for the .replace() below to have any effect.
    const packageRegion = extractPackageValidationRebuildBlock(nativePerPackageSrc)

    // Remove BOTH known-legitimate regions from the full file and verify no
    // stray `npm rebuild` COMMAND remains anywhere else. Pure-comment lines
    // legitimately discuss `npm rebuild` (the header + the explanatory
    // block above NATIVE_MODULES), so strip them first — only actual
    // command lines count (same comment-skip rule as C1(b) below).
    //
    // SMI-5650: also strip `echo`/`printf` lines. The Wave 2 boot-time seed
    // step's own warning message ("… falling back to npm rebuild if
    // validation fails …", docker-entrypoint.sh line ~61) legitimately
    // MENTIONS npm rebuild as advisory prose in a log message — it is not a
    // command invocation, and it lives outside the VALIDATION_FAILED region
    // by design (the boot-time seed step runs before the region even
    // starts). Excluding echo/printf lines keeps this test targeted at
    // actual stray COMMAND invocations, the thing it exists to catch.
    //
    // SMI-5784: the per-package validate+rebuild block is a SIBLING section
    // to VALIDATION_FAILED, not nested inside it (see that block's own
    // comment in docker-entrypoint.sh), so its `npm rebuild` call is
    // legitimately outside the root region — stripped here as a SECOND
    // known-legitimate region rather than left to trip this test.
    const regionText = region as string
    const outsideCommands = entrypointSrc
      .replace(regionText, '')
      .replace(packageRegion, '')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*(echo|printf)\b/.test(l))
      .join('\n')
    expect(outsideCommands).not.toMatch(/\bnpm\s+rebuild\b/)
  })
})

// ---------------------------------------------------------------------------
// C1: Within the VALIDATION_FAILED guard, assert the rebuild loop properties
// ---------------------------------------------------------------------------

describe('C1: rebuild loop assertions (scoped to VALIDATION_FAILED region)', () => {
  it('(a) every NATIVE_MODULES entry is rebuilt with --ignore-scripts=false', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()

    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(nativeModules).not.toBeNull()
    expect(nativeModules!.size).toBeGreaterThan(0)

    // Every module that is in NATIVE_MODULES must appear in an
    // `npm rebuild "${module}" --ignore-scripts=false` invocation within the region.
    // Because the loop iterates over the array variable (not each module by name),
    // we assert the canonical single rebuild command form is present.
    expect(region).toMatch(/npm\s+rebuild\s+"\$\{module\}"\s+--ignore-scripts=false/)
  })

  it('(b) no `npm rebuild` appears in the region without --ignore-scripts=false', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()

    // Find all lines that contain `npm rebuild` in the region
    const lines = region!.split('\n')
    const rebuildLines = lines.filter((l) => /\bnpm\s+rebuild\b/.test(l))

    // Every rebuild line must include --ignore-scripts=false
    for (const line of rebuildLines) {
      // Skip lines that are pure comments
      const stripped = line.replace(/^\s*#.*$/, '').trim()
      if (!stripped) continue
      if (stripped.startsWith('#')) continue
      // Any npm rebuild invocation must carry the flag
      if (/\bnpm\s+rebuild\b/.test(stripped)) {
        expect(
          stripped,
          `Line contains 'npm rebuild' without --ignore-scripts=false: ${stripped}`
        ).toMatch(/--ignore-scripts=false/)
      }
    }
  })

  it('(c) no `if [ "${module}" = ` carve-out remains in the region', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()
    // The original hnswlib-node carve-out was `if [ "${module}" = "hnswlib-node" ]`
    expect(region).not.toMatch(/if\s+\[\s+"\$\{module\}"\s+=\s+/)
  })
})

// ---------------------------------------------------------------------------
// C2: NATIVE_MODULES array equals Dockerfile `RUN npm rebuild …` list
// ---------------------------------------------------------------------------

describe('C2: NATIVE_MODULES sync with Dockerfile', () => {
  it('NATIVE_MODULES is present and non-empty in docker-entrypoint.sh', () => {
    const modules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(modules).not.toBeNull()
    expect(modules!.size).toBeGreaterThan(0)
  })

  it('Dockerfile contains a `RUN npm rebuild …` line that is parseable', () => {
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)
    expect(dockerModules).not.toBeNull()
    expect(dockerModules!.size).toBeGreaterThan(0)
  })

  it("NATIVE_MODULES flat (non-scope) entries equal the Dockerfile `RUN npm rebuild` modules (set equality) — @esbuild is intentionally excluded: `npm rebuild` operates on installed packages with their own build step, and a scope directory has none of its own (see docker-entrypoint-native-rebuild-smi5650.test.ts's asymmetry describe block)", () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)

    expect(nativeModules).not.toBeNull()
    expect(dockerModules).not.toBeNull()

    const nativeArr = flatOnly(nativeModules!)
    const dockerArr = [...dockerModules!].sort()

    expect(
      nativeArr,
      `NATIVE_MODULES flat entries in entrypoint [${nativeArr.join(', ')}] must equal Dockerfile rebuild list [${dockerArr.join(', ')}]`
    ).toEqual(dockerArr)
  })

  it('known modules (better-sqlite3, onnxruntime-node, esbuild, hnswlib-node) are present in both', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)

    expect(nativeModules).not.toBeNull()
    expect(dockerModules).not.toBeNull()

    const expected = ['better-sqlite3', 'onnxruntime-node', 'esbuild', 'hnswlib-node']
    for (const mod of expected) {
      expect(nativeModules!.has(mod), `NATIVE_MODULES missing: ${mod}`).toBe(true)
      expect(dockerModules!.has(mod), `Dockerfile rebuild list missing: ${mod}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// #5: The verbose-hint line carries --ignore-scripts=false
// ---------------------------------------------------------------------------

describe('#5: verbose-hint contains --ignore-scripts=false', () => {
  it('the failure-path verbose hint line includes --ignore-scripts=false', () => {
    // The hint is the `docker exec … npm rebuild ${FAILED_MODULES}` line
    // in the REBUILD_FAILED block. Find it and assert it carries the flag.
    const lines = entrypointSrc.split('\n')
    const hintLines = lines.filter(
      (l) => /docker\s+exec/.test(l) && /npm\s+rebuild/.test(l) && /FAILED_MODULES/.test(l)
    )

    expect(
      hintLines.length,
      'Expected exactly one verbose-hint line (docker exec … npm rebuild ${FAILED_MODULES} …)'
    ).toBeGreaterThan(0)

    for (const hint of hintLines) {
      expect(hint, `Verbose-hint line is missing --ignore-scripts=false:\n  ${hint}`).toMatch(
        /--ignore-scripts=false/
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Parsers sanity-check (unit tests for the helpers above)
// ---------------------------------------------------------------------------

describe('parseBashArray (local helper)', () => {
  it('parses double-quoted entries from a canonical multiline array', () => {
    const src = `NATIVE_MODULES=(\n  "better-sqlite3"\n  "onnxruntime-node"\n)\n`
    const result = parseBashArray(src, 'NATIVE_MODULES')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['better-sqlite3', 'onnxruntime-node'])
  })

  it('returns null when the array is missing', () => {
    expect(parseBashArray('OTHER=(\n  foo\n)\n', 'NATIVE_MODULES')).toBeNull()
  })

  it('returns null for inline-empty array', () => {
    expect(parseBashArray('NATIVE_MODULES=()\n', 'NATIVE_MODULES')).toBeNull()
  })
})

describe('parseDockerfileRebuildLine (local helper)', () => {
  it('parses a space-separated RUN npm rebuild line with || suffix', () => {
    const src = `RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true\n`
    const result = parseDockerfileRebuildLine(src)
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'better-sqlite3',
      'esbuild',
      'hnswlib-node',
      'onnxruntime-node',
    ])
  })

  it('returns null when no RUN npm rebuild line is present', () => {
    const src = `FROM node:22-slim\nRUN apt-get update\n`
    expect(parseDockerfileRebuildLine(src)).toBeNull()
  })

  it('does not include the `|| true` token as a module name', () => {
    const src = `RUN npm rebuild foo bar || true\n`
    const result = parseDockerfileRebuildLine(src)
    expect(result).not.toBeNull()
    expect(result!.has('||')).toBe(false)
    expect(result!.has('true')).toBe(false)
    expect([...result!].sort()).toEqual(['bar', 'foo'])
  })
})
