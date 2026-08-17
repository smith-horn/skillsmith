/**
 * Tests for the SMI-6050 Wave 2 Tier-B (build-tool / compiler platform
 * binary — turbo, Rollup/Rolldown, Astro's compiler, Lightning CSS,
 * Tailwind Oxide, ruvector, workerd, etc.) restore loop in
 * docker-entrypoint.sh.
 *
 * Plan doc: docs/internal/implementation/smi-6050-worktree-linux-optional-platform-binaries.md,
 * "Wave 2: Docker build-time seed + container-boot restore", Step 3. Covers
 * the four behaviors hand-verified live against the running container:
 *   1. First-boot restore from a synthetic Tier-B seed (empty target gets
 *      restored, marker written).
 *   2. No-op when the target's marker already matches the seed's version
 *      marker (idempotent — "already current").
 *   3. Re-seed when the target's marker does NOT match the seed's version
 *      marker (the staleness-detection fix plan-review caught — a plain
 *      "copy only if empty" check would miss a version bump into an
 *      already-populated named volume).
 *   4. No-op / short-circuit entirely when SKILLSMITH_TIER_B_SEED_DISABLE=1
 *      is set.
 *
 * This is the execution-based counterpart to the purely static-assertion
 * convention in docker-entrypoint-native-rebuild-smi5650.test.ts (which only
 * regexes the shell source for structural/list-sync properties) — the
 * Tier-B loop's actual behavior (existence check, version-marker comparison,
 * disable-var short-circuit) can only be proven by really running it against
 * a fixture filesystem. Follows the same extraction/fixture/execution
 * technique docker-entrypoint-native-seed.test.ts already established for
 * the sibling Tier-A (SMI-5650) mechanism — see
 * docker-entrypoint-tier-b-seed.helpers.ts's header for why a NEW sibling
 * pair of files was added here rather than extending either existing
 * SMI-5650 test file directly: neither one's existing structure (pure static
 * regex assertions, or Tier-A's own node/npm-stub fixture shape) fits this
 * loop's generic find-driven, version-marker-comparing shape cleanly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  extractTierBRestoreBlock,
  makeTierBFixture,
  runTierBBlock,
  type TierBFixture,
} from './docker-entrypoint-tier-b-seed.helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker-entrypoint.sh')

describe('docker-entrypoint.sh Tier-B platform-binary restore loop (SMI-6050 Wave 2)', () => {
  let entrypointSrc: string
  let blockRaw: string
  const fixtures: TierBFixture[] = []

  beforeAll(() => {
    entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
    blockRaw = extractTierBRestoreBlock(entrypointSrc)
  })

  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  function newFixture(): TierBFixture {
    const f = makeTierBFixture()
    fixtures.push(f)
    return f
  }

  // -------------------------------------------------------------------------
  // 1. First-boot restore: empty target gets restored, marker written.
  // -------------------------------------------------------------------------

  it('restores an empty target from a synthetic Tier-B seed and writes the version marker (first boot)', () => {
    const fixture = newFixture()
    const relPath = 'node_modules/widget-tier-b'
    const seed = fixture.seedPackageDir(relPath)
    const target = fixture.targetDir(relPath)

    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'binary.node'), 'fake-elf-binary\n', 'utf8')
    writeFileSync(fixture.seedVersionMarker(relPath), '1.2.3', 'utf8')
    mkdirSync(target, { recursive: true }) // present but empty — models a fresh named-volume mount

    const { status, output } = runTierBBlock(fixture, blockRaw)

    expect(status).toBe(0)
    expect(output).toContain(`Restored tier-b ${relPath}@1.2.3 (SMI-6050)`)
    expect(output).toContain('1 restored, 0 already current, 0 skipped')
    expect(existsSync(join(target, 'binary.node'))).toBe(true)
    expect(readFileSync(join(target, 'binary.node'), 'utf8')).toBe('fake-elf-binary\n')
    expect(readFileSync(fixture.targetVersionMarker(relPath), 'utf8')).toBe('1.2.3')
  })

  // -------------------------------------------------------------------------
  // 2. No-op when the target marker already matches the seed's version.
  // -------------------------------------------------------------------------

  it('is a no-op (idempotent) when the target marker already matches the seed version marker', () => {
    const fixture = newFixture()
    const relPath = 'node_modules/widget-tier-b'
    const seed = fixture.seedPackageDir(relPath)
    const target = fixture.targetDir(relPath)

    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'binary.node'), 'fake-elf-binary\n', 'utf8')
    writeFileSync(fixture.seedVersionMarker(relPath), '1.2.3', 'utf8')

    mkdirSync(target, { recursive: true })
    // Target already has content plus a marker that matches the seed
    // version — deliberately DIFFERENT file content from the seed, so a
    // wrongly-triggered restore would be caught by the content assertion
    // below rather than silently masked by an identical overwrite.
    writeFileSync(join(target, 'binary.node'), 'already-restored-content\n', 'utf8')
    writeFileSync(fixture.targetVersionMarker(relPath), '1.2.3', 'utf8')

    const { status, output } = runTierBBlock(fixture, blockRaw)

    expect(status).toBe(0)
    expect(output).not.toContain('Restored tier-b')
    expect(output).toContain('0 restored, 1 already current, 0 skipped')
    // Content must be untouched — proves the no-op path never re-copied.
    expect(readFileSync(join(target, 'binary.node'), 'utf8')).toBe('already-restored-content\n')
  })

  // -------------------------------------------------------------------------
  // 3. Re-seed on a version-marker mismatch (the staleness fix plan-review
  //    caught — a plain "copy only if empty" check would miss this).
  // -------------------------------------------------------------------------

  it('re-seeds when the target marker does NOT match the seed version marker (staleness detection)', () => {
    const fixture = newFixture()
    const relPath = 'node_modules/widget-tier-b'
    const seed = fixture.seedPackageDir(relPath)
    const target = fixture.targetDir(relPath)

    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'binary.node'), 'fake-elf-binary-v2\n', 'utf8')
    writeFileSync(fixture.seedVersionMarker(relPath), '2.0.0', 'utf8')

    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'binary.node'), 'stale-v1-content\n', 'utf8')
    writeFileSync(fixture.targetVersionMarker(relPath), '1.2.3', 'utf8') // stale marker

    const { status, output } = runTierBBlock(fixture, blockRaw)

    expect(status).toBe(0)
    expect(output).toContain(`Restored tier-b ${relPath}@2.0.0 (SMI-6050)`)
    expect(output).toContain('1 restored, 0 already current, 0 skipped')
    expect(readFileSync(join(target, 'binary.node'), 'utf8')).toBe('fake-elf-binary-v2\n')
    expect(readFileSync(fixture.targetVersionMarker(relPath), 'utf8')).toBe('2.0.0')
  })

  // -------------------------------------------------------------------------
  // 4. SKILLSMITH_TIER_B_SEED_DISABLE=1 short-circuits the whole loop.
  // -------------------------------------------------------------------------

  it('SKILLSMITH_TIER_B_SEED_DISABLE=1 short-circuits the loop entirely — no restore, no marker write', () => {
    const fixture = newFixture()
    const relPath = 'node_modules/widget-tier-b'
    const seed = fixture.seedPackageDir(relPath)
    const target = fixture.targetDir(relPath)

    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'binary.node'), 'fake-elf-binary\n', 'utf8')
    writeFileSync(fixture.seedVersionMarker(relPath), '1.2.3', 'utf8')
    mkdirSync(target, { recursive: true }) // empty target — would normally be restored

    const { status, output } = runTierBBlock(fixture, blockRaw, {
      SKILLSMITH_TIER_B_SEED_DISABLE: '1',
    })

    expect(status).toBe(0)
    expect(output).toContain(
      'Tier-B restore disabled via SKILLSMITH_TIER_B_SEED_DISABLE=1 (SMI-6050)'
    )
    expect(output).not.toContain('Restored tier-b')
    expect(existsSync(join(target, 'binary.node'))).toBe(false)
    expect(existsSync(fixture.targetVersionMarker(relPath))).toBe(false)
  })
})
