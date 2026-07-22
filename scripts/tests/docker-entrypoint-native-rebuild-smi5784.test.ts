/**
 * Tests for the SMI-5784 per-package native-module volume seeding logic:
 * docker-entrypoint.sh's per-package boot-time seed step, path-aware
 * validate_native_module() extension, and per-package validate+rebuild
 * block; plus the Dockerfile's per-package stash passes.
 *
 * Extraction/fixture plumbing lives in
 * docker-entrypoint-native-seed-smi5784.helpers.ts (split out per
 * CLAUDE.md's 500-line guidance from the SMI-5650 sibling
 * docker-entrypoint-native-seed.helpers.ts, which this file's imports also
 * reuse directly for the shared makeFixture/runBlock/extractValidateNativeModuleFunction
 * plumbing).
 *
 * Cases (plan doc § 5):
 *   static structure — per-package boot seed step appears before the
 *     per-package validate+rebuild block; disable-var parity backstop
 *     (see the extended count assertion in docker-entrypoint-native-seed.test.ts).
 *   per-package boot-time seed (stub node/npm via runBlock — this step
 *     never calls node/require at all, matching the root boot step):
 *     (a) seeds an empty per-package target from a present per-package
 *         image seed;
 *     (b) warns and does not crash when no per-package image seed exists;
 *     (d) SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 gates the per-package
 *         boot seed identically to root's;
 *     (e) **SYMLINK MODULE-LEAF REGRESSION (code-review blocker)**: when the
 *         packages/<pkg>/node_modules/<module> target itself is a directory
 *         SYMLINK (not the parent node_modules — that's the separate
 *         REALPATH regression below), the boot-time seed step must skip it
 *         exactly like "no target directory" — the `cp -a` seed step must
 *         never write through the symlink into whatever it points at.
 *   per-package validate+rebuild block (REAL node via runBlockRealNode —
 *     the validate_native_module() path-aware branch runs genuine
 *     require.resolve()/startsWith() JS the stub cannot interpret):
 *     - a healthy package-local copy validates cleanly, no rebuild attempted;
 *     - **false-positive-validation regression test (Blocker #2, highest
 *       priority per the plan doc)**: an empty/broken package-local module
 *       directory alongside a healthy ROOT copy of the SAME module name
 *       must FAIL validation (not silently resolve to root) and fall
 *       through to the rebuild path;
 *     - restore-from-seed: a broken package-local copy with a present
 *       per-package image seed restores and short-circuits npm rebuild;
 *     - per-target-failure isolation: one broken package's rebuild does
 *       NOT also touch an already-healthy sibling package's copy;
 *     - disable-var parity: SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1
 *       skips the per-package re-seed-from-stash fast path, falling
 *       through to (stubbed) npm rebuild, mirroring root's reseed fast path;
 *     - **REALPATH FALSE-NEGATIVE REGRESSION (found live, post-implementation,
 *       against a real worktree container)**: the SMI-5570/SMI-5074 mount(2)
 *       clamping mechanism reaches the nominal /app/packages/<pkg>/node_modules
 *       path through a symlink in every real worktree container, so
 *       require.resolve()'s realpath-canonicalized return can false-negative
 *       against a non-canonicalized prefix — a bug this file's other
 *       (plain mkdtemp, no symlink) fixtures never exercised. This test
 *       constructs that exact symlink topology to lock in the fix.
 *     - **SYMLINK MODULE-LEAF REGRESSION (code-review blocker)**: the
 *       validate/rebuild loop's own target-discovery guard must skip a
 *       packages/<pkg>/node_modules/<module> target that is itself a
 *       directory symlink — never validated, never rebuilt, and (the
 *       actual data-loss risk) never reached by the
 *       `rm -rf "${target:?}"/*` re-seed/rebuild recovery, which would
 *       otherwise delete THROUGH the symlink into whatever real directory
 *       it points at.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  extractValidateNativeModuleFunction,
  makeFixture,
  runBlock,
  type Fixture,
} from './docker-entrypoint-native-seed.helpers.js'
import {
  extractPackageBootTimeSeedBlock,
  extractPackageValidationRebuildBlock,
  makeFakeNativeModule,
  runBlockRealNode,
} from './docker-entrypoint-native-seed-smi5784.helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker-entrypoint.sh')
// SMI-5784 file-length split: the per-package boot/validate blocks and the
// SHARED validate_native_module() function this file exercises now live in
// this sourced sibling, not docker-entrypoint.sh itself — see
// docker-entrypoint-native-per-package.sh's own header for the rationale.
const NATIVE_PER_PACKAGE_PATH = resolve(REPO_ROOT, 'docker-entrypoint-native-per-package.sh')

describe('docker-entrypoint.sh PER-PACKAGE native-module seeding (SMI-5784)', () => {
  let entrypointSrc: string
  let nativePerPackageSrc: string
  let packageBootBlockRaw: string
  let packageValidateBlockRaw: string
  let validateFnSrc: string
  const fixtures: Fixture[] = []

  beforeAll(() => {
    entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
    nativePerPackageSrc = readFileSync(NATIVE_PER_PACKAGE_PATH, 'utf8')
    packageBootBlockRaw = extractPackageBootTimeSeedBlock(nativePerPackageSrc)
    packageValidateBlockRaw = extractPackageValidationRebuildBlock(nativePerPackageSrc)
    validateFnSrc = extractValidateNativeModuleFunction(nativePerPackageSrc)
  })

  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  function newFixture(): Fixture {
    const f = makeFixture()
    fixtures.push(f)
    return f
  }

  // Shared invocation for the per-package validate+rebuild block via REAL
  // node — every case in the describe block below runs the SAME
  // (fixture, packageValidateBlockRaw, extraEnv, validateFnSrc) shape,
  // varying only extraEnv (line-count trim, CLAUDE.md's 500-line guidance).
  function runValidateBlock(
    fixture: Fixture,
    extraEnv: Record<string, string> = {}
  ): { status: number; output: string } {
    return runBlockRealNode(fixture, packageValidateBlockRaw, extraEnv, validateFnSrc)
  }

  // -------------------------------------------------------------------------
  // Static structure
  // -------------------------------------------------------------------------

  describe('static structure', () => {
    it('the per-package boot-time seed step appears before the per-package validate+rebuild block', () => {
      // SMI-5784 file-length split: both blocks (and their anchors) now
      // live together in docker-entrypoint-native-per-package.sh, in the
      // same relative order they had inside docker-entrypoint.sh — checked
      // against that file's source instead.
      const bootIdx = nativePerPackageSrc.indexOf(
        '# SMI-5784: seed writable PER-PACKAGE native-module named volumes (worktree'
      )
      const validateIdx = nativePerPackageSrc.indexOf(
        '# SMI-5784: validate + self-heal PER-PACKAGE native-module overlays'
      )
      expect(bootIdx, 'per-package boot-time seed anchor not found').toBeGreaterThan(-1)
      expect(validateIdx, 'per-package validate+rebuild anchor not found').toBeGreaterThan(-1)
      expect(bootIdx).toBeLessThan(validateIdx)
    })

    it('the per-package validate+rebuild block is a SIBLING of the root VALIDATION_FAILED block, not nested inside it', () => {
      // Regression guard for the specific design mistake the plan doc's
      // Rebuild section warns against: nesting the per-package block
      // inside `if [ $VALIDATION_FAILED -eq 1 ]` would skip per-package
      // validation entirely whenever every root module validates cleanly.
      //
      // SMI-5784 file-length split: the per-package block's own
      // implementation (and its anchor comment) moved to
      // docker-entrypoint-native-per-package.sh, so the invariant is now
      // checked at the CALL SITE left behind in docker-entrypoint.sh — the
      // `validate_and_rebuild_per_package_native_modules` call must appear
      // after "Native modules rebuilt successfully." (i.e. after the root
      // VALIDATION_FAILED block has fully closed), not nested inside it.
      const validationFailedIdx = entrypointSrc.indexOf('if [ $VALIDATION_FAILED -eq 1 ]')
      const packageCallIdx = entrypointSrc.indexOf(
        'validate_and_rebuild_per_package_native_modules'
      )
      expect(validationFailedIdx).toBeGreaterThan(-1)
      expect(packageCallIdx, 'per-package validate+rebuild call site not found').toBeGreaterThan(-1)
      // The per-package call must appear AFTER the text
      // "Native modules rebuilt successfully." — i.e. after the root
      // VALIDATION_FAILED block has fully closed — rather than anywhere
      // inside that block's own body.
      const rootRebuiltIdx = entrypointSrc.indexOf('Native modules rebuilt successfully.')
      expect(rootRebuiltIdx).toBeGreaterThan(-1)
      expect(packageCallIdx).toBeGreaterThan(rootRebuiltIdx)
    })

    it('validate_native_module() dispatches to the path-aware branch when called with a second argument', () => {
      expect(validateFnSrc).toMatch(/if \[ -n "\$\{2:-\}" \]; then/)
      expect(validateFnSrc).toMatch(/require\.resolve\('\$probe',\{paths:\['\$2'\]\}\)/)
      expect(validateFnSrc).toMatch(/startsWith/)
    })
  })

  // -------------------------------------------------------------------------
  // Per-package BOOT-TIME seed step (stub node/npm via runBlock — this
  // step never calls node/require, matching the root boot step's own
  // file-marker-based already_seeded check).
  // -------------------------------------------------------------------------

  describe('per-package boot-time seed step', () => {
    it('(a) seeds an empty per-package target from a present per-package image seed', () => {
      const fixture = newFixture()
      const seed = fixture.packageSeedDir('core', 'better-sqlite3')
      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'package.json'), '{"name":"better-sqlite3"}\n', 'utf8')
      writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
      mkdirSync(target, { recursive: true }) // named-volume overlay: present, empty

      const { status, output } = runBlock(fixture, packageBootBlockRaw)

      expect(status).toBe(0)
      expect(output).toContain('Seeded core/better-sqlite3 into writable overlay (SMI-5784)')
      expect(existsSync(join(target, 'package.json'))).toBe(true)
      expect(existsSync(join(target, 'GOOD_MARKER'))).toBe(true)
    })

    it('(b) warns and does not crash when no per-package image seed exists', () => {
      const fixture = newFixture()
      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      mkdirSync(target, { recursive: true }) // empty overlay, no seed shipped in the image
      // Deliberately do NOT create fixture.packageSeedDir('core', 'better-sqlite3').

      const { status, output } = runBlock(fixture, packageBootBlockRaw)

      expect(status).toBe(0)
      expect(output).toContain('No native seed for core/better-sqlite3')
    })

    it('a package with no target directory at all (no divergence) is a silent no-op — no output, no crash', () => {
      const fixture = newFixture()
      // Deliberately create neither the target nor the seed for ANY
      // package — mirrors the common case where scripts/_lib.sh never
      // mounted a per-package overlay because the package never diverges.
      mkdirSync(join(fixture.root, 'app', 'packages', 'core'), { recursive: true })

      const { status, output } = runBlock(fixture, packageBootBlockRaw)

      expect(status).toBe(0)
      expect(output.trim()).toBe('')
    })

    it('(d) SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 gates the per-package boot seed identically to root (H2 parity, SMI-5784)', () => {
      const fixture = newFixture()
      const seed = fixture.packageSeedDir('core', 'better-sqlite3')
      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'package.json'), '{"name":"better-sqlite3"}\n', 'utf8')
      writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
      mkdirSync(target, { recursive: true })

      const { status, output } = runBlock(fixture, packageBootBlockRaw, {
        SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE: '1',
      })

      expect(status).toBe(0)
      expect(output.trim()).toBe('')
      expect(existsSync(join(target, 'GOOD_MARKER'))).toBe(false)
    })

    it("(e) SYMLINK MODULE-LEAF REGRESSION (code-review blocker): a packages/<pkg>/node_modules/<module> target that is itself a directory SYMLINK is skipped entirely — the seed step never cp -a's through it", () => {
      const fixture = newFixture()
      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      // The symlink's REAL destination — stands in for content that must
      // never be touched (e.g. the root native-seed volume's real content,
      // per the code-review finding). Not itself a valid native module (no
      // package.json) so an unfixed guard following the symlink would also
      // report "no native seed" noise if it got that far — this test
      // asserts it never gets that far at all.
      const elsewhere = join(fixture.root, 'elsewhere-target')
      mkdirSync(elsewhere, { recursive: true })
      writeFileSync(join(elsewhere, 'SENTINEL'), 'do-not-touch\n', 'utf8')
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(elsewhere, target)

      // A present per-package image seed with real content — if the
      // unfixed `[ -d "$target" ]`-only guard let this through, `cp -a`
      // would write package.json/GOOD_MARKER THROUGH the symlink into
      // `elsewhere`.
      const seed = fixture.packageSeedDir('core', 'better-sqlite3')
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'package.json'), '{"name":"better-sqlite3"}\n', 'utf8')
      writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')

      const { status, output } = runBlock(fixture, packageBootBlockRaw)

      expect(status).toBe(0)
      // Silent no-op — identical output shape to the "no target directory
      // at all" case above (the symlink guard collapses to the same
      // continue).
      expect(output.trim()).toBe('')
      expect(output).not.toContain('core/better-sqlite3')
      // The symlink itself must still be a symlink — nothing dereferenced
      // or replaced it.
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
      // Nothing was written through the symlink into its real destination.
      expect(existsSync(join(elsewhere, 'package.json'))).toBe(false)
      expect(existsSync(join(elsewhere, 'GOOD_MARKER'))).toBe(false)
      expect(readFileSync(join(elsewhere, 'SENTINEL'), 'utf8')).toBe('do-not-touch\n')
    })
  })

  // -------------------------------------------------------------------------
  // Per-package VALIDATE + REBUILD block (REAL node via runBlockRealNode).
  // -------------------------------------------------------------------------

  describe('per-package validate+rebuild block (real node)', () => {
    it('a healthy package-local copy validates cleanly — no rebuild attempted', () => {
      const fixture = newFixture()
      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      makeFakeNativeModule(target, 'better-sqlite3', 'PACKAGE-LOCAL-HEALTHY')

      const { status, output } = runValidateBlock(fixture)

      expect(status).toBe(0)
      expect(output).toContain('✓ core/better-sqlite3')
      expect(output).not.toContain('validation failed')
      expect(existsSync(fixture.npmRebuildLog)).toBe(false)
    })

    it('FALSE-POSITIVE-VALIDATION REGRESSION (Blocker #2, highest priority): an empty package-local dir alongside a healthy ROOT copy of the same module must FAIL validation, not silently resolve to root', () => {
      const fixture = newFixture()
      // Healthy ROOT copy — a DIFFERENT, wrong-for-this-package copy that a
      // naive relative require() would silently fall through to.
      makeFakeNativeModule(
        fixture.nodeModulesDir('better-sqlite3'),
        'better-sqlite3',
        'ROOT-WRONG-COPY'
      )
      // Package-local target exists (a native-seed volume was mounted
      // there) but is COMPLETELY EMPTY — no package.json, no index.js —
      // simulating a broken/mid-install state. No image seed either, and
      // npm rebuild is stubbed to a no-op, so this target must end up in
      // PACKAGE_TARGETS_FAILED.
      mkdirSync(fixture.packageNodeModulesDir('core', 'better-sqlite3'), { recursive: true })

      const { status, output } = runValidateBlock(fixture)

      // The block's own exit-1 path fires because PACKAGE_TARGETS_FAILED
      // is non-empty — proving validation genuinely FAILED rather than
      // silently passing by resolving to the root copy.
      expect(status).toBe(1)
      expect(output).toContain('core/better-sqlite3 - validation failed')
      expect(output).toContain('still failing after rebuild')
      expect(output).toContain(
        'Per-package native module validation failed after rebuild: core/better-sqlite3'
      )
      // The regression this guards against: the OLD relative-require design
      // would never have reached "validation failed" at all for this case —
      // it would have silently resolved the root copy and reported success.
      expect(output).not.toContain('✓ core/better-sqlite3')
    })

    it('restore-from-seed: a broken package-local copy with a present per-package image seed restores and short-circuits npm rebuild', () => {
      const fixture = newFixture()
      const seedDir = fixture.packageSeedDir('core', 'better-sqlite3')
      makeFakeNativeModule(seedDir, 'better-sqlite3', 'SEED-COPY')
      // Package-local target starts broken (empty) — validation must fail
      // first, then the re-seed-from-stash fast path restores it.
      mkdirSync(fixture.packageNodeModulesDir('core', 'better-sqlite3'), { recursive: true })

      const { status, output } = runValidateBlock(fixture)

      expect(status).toBe(0)
      expect(output).toContain('core/better-sqlite3 restored from image seed (SMI-5784)')
      expect(existsSync(fixture.npmRebuildLog)).toBe(false)
    })

    it('PER-TARGET-FAILURE ISOLATION: one broken package (no seed, stubbed rebuild) does NOT trigger a rebuild of an already-healthy sibling package', () => {
      const fixture = newFixture()
      // core: broken, no seed — will fail validation, fall through to
      // (stubbed) npm rebuild, and remain failing (stub never actually
      // fixes anything).
      mkdirSync(fixture.packageNodeModulesDir('core', 'better-sqlite3'), { recursive: true })
      // doc-retrieval-mcp: healthy — must validate cleanly and NEVER be
      // touched by npm rebuild, even though core's rebuild ran in the SAME
      // loop iteration cycle.
      makeFakeNativeModule(
        fixture.packageNodeModulesDir('doc-retrieval-mcp', 'better-sqlite3'),
        'better-sqlite3',
        'HEALTHY-SIBLING'
      )

      const { status, output } = runValidateBlock(fixture)

      expect(status).toBe(1)
      expect(output).toContain('✓ doc-retrieval-mcp/better-sqlite3')
      expect(output).toContain('core/better-sqlite3 - validation failed')
      expect(output).toContain(
        'Per-package native module validation failed after rebuild: core/better-sqlite3'
      )
      // The healthy sibling must NEVER appear in the failed-targets list.
      expect(output).not.toContain('doc-retrieval-mcp/better-sqlite3 - validation failed')
      // npm rebuild was invoked for core, but never for doc-retrieval-mcp.
      expect(existsSync(fixture.npmRebuildLog)).toBe(true)
      const rebuildLog = readFileSync(fixture.npmRebuildLog, 'utf8').trim().split('\n')
      expect(rebuildLog).toContain('better-sqlite3')
      expect(rebuildLog.length).toBe(1) // exactly one rebuild attempt, for core only
    })

    it('DISABLE-VAR PARITY: SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 skips the per-package re-seed-from-stash fast path, falling through to (stubbed) npm rebuild — mirrors root reseed fast path', () => {
      const fixture = newFixture()
      const seedDir = fixture.packageSeedDir('core', 'better-sqlite3')
      makeFakeNativeModule(seedDir, 'better-sqlite3', 'SEED-COPY-SHOULD-BE-IGNORED')
      mkdirSync(fixture.packageNodeModulesDir('core', 'better-sqlite3'), { recursive: true })

      const { output } = runValidateBlock(fixture, {
        SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE: '1',
      })

      expect(output).not.toContain('restored from image seed')
      // Falls through to the SAME npm rebuild call used when no seed
      // exists at all — the disable var must not open a third, untested
      // code path.
      expect(existsSync(fixture.npmRebuildLog)).toBe(true)
      expect(readFileSync(fixture.npmRebuildLog, 'utf8').trim().split('\n')).toContain(
        'better-sqlite3'
      )
    })

    it('REALPATH FALSE-NEGATIVE REGRESSION (found live against a real worktree container, post-implementation): a healthy package-local copy reached through a symlink indirection (the SMI-5570/SMI-5074 mount(2) clamping shape every real worktree container has) must still validate — require.resolve() returns a realpath-canonicalized path, and the prefix check must canonicalize the SAME way or it false-negatives a genuinely correct resolution', () => {
      const fixture = newFixture()
      // Construct the REAL topology: the actual per-package node_modules
      // content lives at a DIFFERENT real path, and the nominal
      // /app/packages/core/node_modules path the entrypoint passes as $2
      // is a SYMLINK to it — exactly what `mount | grep` shows inside a
      // real worktree container (real mount lands at /packages/<pkg>/node_modules,
      // /app/packages/<pkg>/node_modules is a symlink alias to it).
      const realNodeModulesDir = join(fixture.root, 'real-elsewhere', 'core-node-modules')
      makeFakeNativeModule(
        join(realNodeModulesDir, 'better-sqlite3'),
        'better-sqlite3',
        'REAL-HEALTHY-VIA-SYMLINK'
      )

      const nominalPkgDir = join(fixture.root, 'app', 'packages', 'core')
      mkdirSync(nominalPkgDir, { recursive: true })
      const nominalNodeModules = join(nominalPkgDir, 'node_modules')
      symlinkSync(realNodeModulesDir, nominalNodeModules)

      // fixture.packageNodeModulesDir('core', 'better-sqlite3') would
      // resolve THROUGH the symlink transparently for existsSync/mkdirSync
      // purposes, but the extracted block itself computes
      // pkg_node_modules="/app/packages/${pkg}/node_modules" (the NOMINAL,
      // symlinked path) at runtime — exactly the value that gets passed as
      // validate_native_module()'s second argument, so this fixture shape
      // is what actually exercises the bug.

      const { status, output } = runValidateBlock(fixture)

      expect(status).toBe(0)
      expect(output).toContain('✓ core/better-sqlite3')
      expect(output).not.toContain('validation failed')
      expect(existsSync(fixture.npmRebuildLog)).toBe(false)
    })

    it('SYMLINK MODULE-LEAF REGRESSION (code-review blocker): a packages/<pkg>/node_modules/<module> target that is itself a directory SYMLINK is skipped entirely — never validated, never rebuilt, and never reached by the rm -rf re-seed/rebuild recovery', () => {
      const fixture = newFixture()
      // The symlink's REAL destination — models the exact risk the
      // code-review finding called out: if validation wrongly ran and
      // failed for a symlinked target, the re-seed/rebuild recovery's
      // `rm -rf "${target:?}"/*` would delete THROUGH the symlink into
      // whatever real directory it points at (e.g. the root native-seed
      // volume's real content). PRECIOUS_DATA stands in for that content.
      const elsewhere = join(fixture.root, 'elsewhere-target')
      mkdirSync(elsewhere, { recursive: true })
      writeFileSync(join(elsewhere, 'PRECIOUS_DATA'), 'must-survive\n', 'utf8')

      const target = fixture.packageNodeModulesDir('core', 'better-sqlite3')
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(elsewhere, target)
      // `elsewhere` deliberately holds no valid better-sqlite3 module (no
      // package.json/index.js) — if the guard failed to skip this target,
      // validate_native_module() would genuinely fail here, which is
      // exactly the scenario that must never be allowed to reach the
      // rm -rf recovery path.

      const { status, output } = runValidateBlock(fixture)

      // Skipped entirely: no target ever entered PACKAGE_TARGETS_FAILED,
      // so the block's own overall exit-1 path never fires.
      expect(status).toBe(0)
      expect(output).toContain('All per-package native module overlays validated.')
      // Never validated (no pass, no fail) and never rebuilt for this
      // target — the continue fires before validate_native_module() is
      // even called.
      expect(output).not.toContain('core/better-sqlite3')
      expect(existsSync(fixture.npmRebuildLog)).toBe(false)
      // The critical data-loss assertion: the rm -rf re-seed/rebuild
      // recovery never ran, so the symlink's real destination is
      // untouched — still a symlink, content still present.
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(elsewhere, 'PRECIOUS_DATA'), 'utf8')).toBe('must-survive\n')
    })
  })
})
