/**
 * Tests for the SMI-5650 Wave 2 native-module tmpfs seed logic in
 * docker-entrypoint.sh: the boot-time seed step (before the validation loop)
 * and the VALIDATION_FAILED rebuild loop's re-seed-first fast path.
 *
 * Extraction/fixture plumbing lives in the sibling
 * docker-entrypoint-native-seed.helpers.ts (split out per CLAUDE.md's
 * 500-line guidance) — see that file's header for the extraction technique.
 *
 * Cases (plan §6 item 4):
 *   static   — the boot-time seed block appears before the validation loop;
 *              both call-sites reference the identical disable-var guard
 *              (cheap structural backstop, belt-and-suspenders with (d)).
 *   (a)      — boot-time seed step copies a present image seed into an
 *              empty target and reports success.
 *   (b)      — boot-time seed step warns (does not crash) when no image
 *              seed exists for a module.
 *   (missing)— validation-loop fast path falls through to npm rebuild when
 *              no image seed exists (distinct from the disable-var fallback
 *              in (d) below — same destination, different guard clause).
 *   (c)      — validation-loop fast path restores from the image seed and
 *              short-circuits npm rebuild when the seed alone satisfies a
 *              (stubbed) require().
 *   (d)      — CRITICAL H2 regression test: SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1
 *              must be honored IDENTICALLY by BOTH call-sites. An earlier
 *              draft gated only one of the two; plan-review caught it. This
 *              is the single most important test in this file.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  extractBootTimeSeedBlock,
  extractReseedFastPathWithFallback,
  extractValidateNativeModuleFunction,
  makeFixture,
  runBlock,
  withTestModules,
  wrapInLoop,
  type Fixture,
} from './docker-entrypoint-native-seed.helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker-entrypoint.sh')

describe('docker-entrypoint.sh native-module tmpfs seed (SMI-5650 Wave 2)', () => {
  let entrypointSrc: string
  let bootBlockRaw: string
  let reseedBlockRaw: string
  // The reseed fast path now calls the shared validate_native_module()
  // helper (SMI-5650 fix: a bare `require('${module}')` is a false green
  // for better-sqlite3/esbuild) — extracted once and prepended ahead of
  // reseedBlockRaw wherever it's executed, or the extracted snippet fails
  // with "command not found: validate_native_module".
  let validateFnSrc: string
  const fixtures: Fixture[] = []

  beforeAll(() => {
    entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
    bootBlockRaw = extractBootTimeSeedBlock(entrypointSrc)
    reseedBlockRaw = extractReseedFastPathWithFallback(entrypointSrc)
    validateFnSrc = extractValidateNativeModuleFunction(entrypointSrc)
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

  // -------------------------------------------------------------------------
  // Static structure — cheap backstop, complements the behavioral (d) below.
  // -------------------------------------------------------------------------

  describe('static structure', () => {
    it('the boot-time seed step appears before the native-module validation loop', () => {
      const seedIdx = entrypointSrc.indexOf(
        '# SMI-5650: seed writable native-module named volumes (worktree only).'
      )
      const validationIdx = entrypointSrc.indexOf('[entrypoint] Validating native modules...')
      expect(seedIdx, 'boot-time seed anchor not found').toBeGreaterThan(-1)
      expect(validationIdx, 'validation loop start marker not found').toBeGreaterThan(-1)
      expect(seedIdx).toBeLessThan(validationIdx)
    })

    it('both seed call-sites reference the IDENTICAL disable-var guard clause (H2 parity backstop)', () => {
      const guard = '"${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1"'
      const occurrences = entrypointSrc.split(guard).length - 1
      expect(
        occurrences,
        'Expected the disable-var guard clause to appear exactly twice (boot-time step + ' +
          'validation-loop fast path). A count of 1 is the exact H2 regression plan-review caught: ' +
          'only one of the two call-sites gated.'
      ).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // (a) Boot-time seed step correctly seeds an empty target.
  // -------------------------------------------------------------------------

  it('(a) boot-time seed step copies a present image seed into an empty target and reports success', () => {
    const fixture = newFixture()
    const seed = fixture.seedDir('widget-mod')
    const target = fixture.nodeModulesDir('widget-mod')
    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'package.json'), '{"name":"widget-mod"}\n', 'utf8')
    writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
    mkdirSync(target, { recursive: true }) // tmpfs overlay: present, empty

    const block = withTestModules(bootBlockRaw, ['widget-mod'])
    const { status, output } = runBlock(fixture, block)

    expect(status).toBe(0)
    expect(output).toContain('Seeded widget-mod into writable overlay (SMI-5650)')
    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(existsSync(join(target, 'GOOD_MARKER'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // (b) A module with no shipped seed falls through with only a warning.
  // -------------------------------------------------------------------------

  it('(b) boot-time seed step warns and does not crash when no image seed exists for a module', () => {
    const fixture = newFixture()
    const target = fixture.nodeModulesDir('widget-mod')
    mkdirSync(target, { recursive: true }) // empty tmpfs overlay, no seed shipped in the image
    // Deliberately do NOT create fixture.seedDir('widget-mod').

    const block = withTestModules(bootBlockRaw, ['widget-mod'])
    const { status, output } = runBlock(fixture, block)

    expect(status).toBe(0)
    expect(output).toContain('No native seed for widget-mod')
    expect(readdirSync(target)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Missing-seed fallback in the VALIDATION_FAILED loop (plan §6 item 4,
  // distinct from the disable-var fallback in (d)): an image built before
  // SMI-5650 has no /opt/native-seed at all, so the fast path's own
  // `[ -d ... ]` guard is false and control falls through to the existing
  // npm rebuild call.
  // -------------------------------------------------------------------------

  it('validation-loop fast path falls through to npm rebuild when no image seed exists (pre-SMI-5650 image)', () => {
    const fixture = newFixture()
    const target = fixture.nodeModulesDir('widget-mod')
    mkdirSync(target, { recursive: true })
    // Deliberately do NOT create fixture.seedDir('widget-mod').

    const block = wrapInLoop(reseedBlockRaw, ['widget-mod'])
    const { status, output } = runBlock(fixture, block, {}, validateFnSrc)

    expect(status).toBe(0)
    expect(output).not.toContain('restored from image seed')
    expect(existsSync(fixture.npmRebuildLog)).toBe(true)
    expect(readFileSync(fixture.npmRebuildLog, 'utf8').trim().split('\n')).toContain('widget-mod')
    // The fast path never touched the target — no rm -rf, no cp.
    expect(readdirSync(target)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // (c) Validation-loop re-seed-first fast path short-circuits npm rebuild.
  // -------------------------------------------------------------------------

  it('(c) validation-loop fast path restores from the image seed and short-circuits npm rebuild', () => {
    const fixture = newFixture()
    const seed = fixture.seedDir('widget-mod')
    const target = fixture.nodeModulesDir('widget-mod')
    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
    // Target starts with stale/corrupt content (no GOOD_MARKER) — models the
    // validation failure the fast path must clear before re-seeding.
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'BAD_MARKER'), 'corrupt\n', 'utf8')

    const block = wrapInLoop(reseedBlockRaw, ['widget-mod'])
    const { status, output } = runBlock(fixture, block, {}, validateFnSrc)

    expect(status).toBe(0)
    expect(output).toContain('widget-mod restored from image seed (SMI-5650)')
    // npm rebuild must NEVER be invoked — the `continue` inside the fast
    // path's success branch skips the sibling npm-rebuild fallback line.
    expect(existsSync(fixture.npmRebuildLog)).toBe(false)
    expect(existsSync(join(target, 'GOOD_MARKER'))).toBe(true)
    expect(existsSync(join(target, 'BAD_MARKER'))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // (d) CRITICAL H2 regression test.
  // -------------------------------------------------------------------------

  describe('(d) H2 regression: SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 gates BOTH call-sites identically', () => {
    it('boot-time seed step declines to seed and writes nothing into the target', () => {
      const fixture = newFixture()
      const seed = fixture.seedDir('widget-mod')
      const target = fixture.nodeModulesDir('widget-mod')
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'package.json'), '{"name":"widget-mod"}\n', 'utf8')
      writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
      mkdirSync(target, { recursive: true })

      const block = withTestModules(bootBlockRaw, ['widget-mod'])
      const { status, output } = runBlock(fixture, block, {
        SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE: '1',
      })

      expect(status).toBe(0)
      expect(output).not.toContain('Seeded widget-mod')
      // The disable var short-circuits the OUTER if — nothing in the block
      // runs at all, not even the "no seed" warning.
      expect(output.trim()).toBe('')
      expect(readdirSync(target)).toEqual([])
    })

    it('validation-loop fast path declines to re-seed and falls through to npm rebuild instead', () => {
      const fixture = newFixture()
      const seed = fixture.seedDir('widget-mod')
      const target = fixture.nodeModulesDir('widget-mod')
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'GOOD_MARKER'), 'ok\n', 'utf8')
      mkdirSync(target, { recursive: true })

      const block = wrapInLoop(reseedBlockRaw, ['widget-mod'])
      const { status, output } = runBlock(
        fixture,
        block,
        { SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE: '1' },
        validateFnSrc
      )

      expect(status).toBe(0)
      expect(output).not.toContain('restored from image seed')
      // Neither the rm -rf nor the cp -a inside the fast path's if-body ran
      // — the target must be exactly as it started (empty), even though a
      // perfectly good seed was available.
      expect(readdirSync(target)).toEqual([])
      // Falls through to the SAME ordinary npm rebuild call used when no
      // seed exists at all — the disable var must not open a third,
      // untested code path.
      expect(existsSync(fixture.npmRebuildLog)).toBe(true)
      expect(readFileSync(fixture.npmRebuildLog, 'utf8').trim().split('\n')).toContain('widget-mod')
    })
  })
})
