/**
 * @fileoverview A write that is REFUSED leaves the manifest byte-identical.
 * @module @skillsmith/core/tests/unit/services/skill-installation.adoption-degraded-manifest.test
 * @see docs/internal/adr/171-manifest-read-state-contract.md — § 1
 * @see SMI-6733 — CRITICAL 1 and CRITICAL 2
 *
 * **Every test here asserts the FILE'S BYTES, not only the message.** ADR-171
 * § 1 is a statement about the file ("refuses the write and leaves the file
 * byte-identical … No writer saves after a failed load"), so a test that
 * checks only the returned string is not testing it. That is not a stylistic
 * preference: `skill-installation.uninstall.guard.test.ts:2179` writes a
 * corrupt manifest, asserts a refusal message, never looks at the file, and
 * passed throughout the entire window in which a refused uninstall was
 * rewriting that file. The message and the bytes are two independent claims
 * and only one of them was ever checked.
 *
 * So each case captures length + SHA-256 before and after, and asserts
 * identity on every refusing path. The `force: true` cases assert the
 * opposite — that the file DID change — because a test suite in which every
 * assertion is "nothing happened" passes just as well against code that does
 * nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { adoptUntrackedSkillEntry } from '../../../src/services/skill-installation.uninstall.helpers.js'
import { performUninstall } from '../../../src/services/skill-installation.uninstall.js'
import { ManifestManager } from '../../../src/services/skill-manifest.js'
import type { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'

/**
 * `performUninstall` calls exactly one method on the dependency repo, inside
 * its own try/catch ("table may not exist pre-migration"). A real repo would
 * need a database none of these cases exercises, so the seam is stubbed
 * rather than built.
 */
const stubDependencyRepo = {
  clearAll: (): void => undefined,
} as unknown as SkillDependencyRepository

interface FileFingerprint {
  bytes: number
  sha256: string
}

async function fingerprint(filePath: string): Promise<FileFingerprint> {
  const contents = await fs.readFile(filePath)
  return {
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  }
}

/**
 * A manifest whose readable prefix records a REAL skill, followed by trailing
 * garbage that makes `JSON.parse` reject the whole file.
 *
 * This fixture is the point. A manifest that is merely malformed loses
 * nothing when it is replaced; this one holds a record a user would
 * genuinely miss, in a file that no longer parses — which is the state a
 * truncated or half-written manifest is actually in, and the state the
 * refusal exists to protect.
 */
function manifestWithRecoverableRecord(betaInstallPath: string): string {
  const readable = JSON.stringify(
    {
      version: '1.0.0',
      installedSkills: {
        beta: {
          id: 'beta',
          name: 'beta',
          version: '1.2.3',
          source: 'github:acme/beta',
          installPath: betaInstallPath,
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z',
        },
      },
    },
    null,
    2
  )
  return `${readable}\n}}} trailing garbage`
}

describe('a refused manifest write leaves the file byte-identical (SMI-6733)', () => {
  let tmpDir: string
  let manifestPath: string
  let skillsDir: string
  let untrackedSkillDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-degraded-manifest-'))
    manifestPath = path.join(tmpDir, 'manifest.json')
    skillsDir = path.join(tmpDir, 'skills')
    untrackedSkillDir = path.join(skillsDir, 'alpha')
    await fs.mkdir(untrackedSkillDir, { recursive: true })
    await fs.writeFile(path.join(untrackedSkillDir, 'SKILL.md'), '# alpha\n')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // CRITICAL 1 — adoption's own write, the path `sklx update` reaches
  // --------------------------------------------------------------------------

  describe('CRITICAL 1: adoptUntrackedSkillEntry without tolerance', () => {
    it('refuses, and the unreadable manifest still holds the record it recorded', async () => {
      const original = manifestWithRecoverableRecord(path.join(skillsDir, 'beta'))
      await fs.writeFile(manifestPath, original)
      const before = await fingerprint(manifestPath)

      // No sixth argument — the shape `getSkillDiff` uses, and the shape any
      // future call site gets by default.
      const result = await adoptUntrackedSkillEntry(
        'alpha',
        'alpha',
        untrackedSkillDir,
        'alpha',
        new ManifestManager(manifestPath)
      )

      // The refusal is reported, not swallowed into an apparent success.
      expect('adoptionRefusal' in result).toBe(true)

      const after = await fingerprint(manifestPath)
      expect(after).toEqual(before)
      // Asserted on the CONTENT and not only the digest, so a reader can see
      // what survived rather than trusting a hash comparison to mean it.
      expect(await fs.readFile(manifestPath, 'utf-8')).toBe(original)
      expect(await fs.readFile(manifestPath, 'utf-8')).toContain('"beta"')
      expect(await fs.readFile(manifestPath, 'utf-8')).toContain('github:acme/beta')
    })

    it('POSITIVE CONTROL: with tolerance it does write, so the refusal above is a decision and not an inert call', async () => {
      await fs.writeFile(manifestPath, manifestWithRecoverableRecord(path.join(skillsDir, 'beta')))
      const before = await fingerprint(manifestPath)

      const result = await adoptUntrackedSkillEntry(
        'alpha',
        'alpha',
        untrackedSkillDir,
        'alpha',
        new ManifestManager(manifestPath),
        { tolerateDegradedRead: true }
      )

      expect('adoptionRefusal' in result).toBe(false)
      expect(await fingerprint(manifestPath)).not.toEqual(before)
    })

    it('POSITIVE CONTROL: on a READABLE manifest, adoption writes without tolerance — only a degraded read is gated', async () => {
      const doc = { version: '1.0.0', installedSkills: {} }
      await fs.writeFile(manifestPath, JSON.stringify(doc, null, 2))
      const before = await fingerprint(manifestPath)

      const result = await adoptUntrackedSkillEntry(
        'alpha',
        'alpha',
        untrackedSkillDir,
        'alpha',
        new ManifestManager(manifestPath)
      )

      expect('adoptionRefusal' in result).toBe(false)
      expect('adoptionError' in result).toBe(false)
      expect(await fingerprint(manifestPath)).not.toEqual(before)
      const written = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
        installedSkills: Record<string, unknown>
      }
      expect(written.installedSkills.alpha).toBeDefined()
    })
  })

  // --------------------------------------------------------------------------
  // CRITICAL 2 — a REFUSED uninstall must not rewrite the manifest
  // --------------------------------------------------------------------------

  describe('CRITICAL 2: performUninstall with force: false', () => {
    // Both shapes the measurement covered. The first cannot be parsed at all;
    // the second parses and fails the container check. They refuse through
    // different classifier branches and must leave the file alone in both.
    const degraded: Array<{ label: string; contents: string }> = [
      { label: 'unparseable JSON', contents: '{not json' },
      {
        label: 'valid JSON, wrong shape',
        contents: '{"version":"1.0.0","installedSkills":"hello"}',
      },
    ]

    for (const { label, contents } of degraded) {
      it(`refuses and leaves the file byte-identical: ${label}`, async () => {
        await fs.writeFile(manifestPath, contents)
        const before = await fingerprint(manifestPath)

        const result = await performUninstall({
          skillName: 'alpha',
          force: false,
          skillsDir,
          manifest: new ManifestManager(manifestPath),
          skillDependencyRepo: stubDependencyRepo,
          onProgress: () => undefined,
        })

        expect(result.success).toBe(false)
        expect(await fingerprint(manifestPath)).toEqual(before)
        expect(await fs.readFile(manifestPath, 'utf-8')).toBe(contents)
        // The skill is still on disk: a refusal removes nothing either.
        await expect(fs.access(untrackedSkillDir)).resolves.toBeUndefined()
        // The refusal must not tell the user to restore a backup while the
        // same call has just overwritten the thing a backup would restore.
        // This assertion is only meaningful alongside the byte check above.
        expect(result.message).toMatch(/NOT been modified|could not be read/)
      })
    }

    it('refuses a manifest holding a real record, and that record survives', async () => {
      const original = manifestWithRecoverableRecord(path.join(skillsDir, 'beta'))
      await fs.writeFile(manifestPath, original)
      const before = await fingerprint(manifestPath)

      const result = await performUninstall({
        skillName: 'alpha',
        force: false,
        skillsDir,
        manifest: new ManifestManager(manifestPath),
        skillDependencyRepo: stubDependencyRepo,
        onProgress: () => undefined,
      })

      expect(result.success).toBe(false)
      expect(await fingerprint(manifestPath)).toEqual(before)
      expect(await fs.readFile(manifestPath, 'utf-8')).toContain('github:acme/beta')
    })

    it('POSITIVE CONTROL: force: true proceeds, removes the directory, and DOES rewrite the manifest', async () => {
      await fs.writeFile(manifestPath, '{"version":"1.0.0","installedSkills":"hello"}')
      const before = await fingerprint(manifestPath)

      const result = await performUninstall({
        skillName: 'alpha',
        force: true,
        skillsDir,
        manifest: new ManifestManager(manifestPath),
        skillDependencyRepo: stubDependencyRepo,
        onProgress: () => undefined,
      })

      expect(result.success).toBe(true)
      await expect(fs.access(untrackedSkillDir)).rejects.toMatchObject({ code: 'ENOENT' })
      // The contrast that makes every `toEqual(before)` above load-bearing:
      // the same fixture, the same call, one flag different, and the file
      // genuinely changes.
      expect(await fingerprint(manifestPath)).not.toEqual(before)
    })

    it('POSITIVE CONTROL: a readable manifest still uninstalls without force', async () => {
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ version: '1.0.0', installedSkills: {} }, null, 2)
      )

      const result = await performUninstall({
        skillName: 'alpha',
        force: false,
        skillsDir,
        manifest: new ManifestManager(manifestPath),
        skillDependencyRepo: stubDependencyRepo,
        onProgress: () => undefined,
      })

      expect(result.success).toBe(true)
      await expect(fs.access(untrackedSkillDir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  // --------------------------------------------------------------------------
  // MAJOR 3 — a nullish `installedSkills` classifies `ok` and must not crash
  // --------------------------------------------------------------------------

  describe('MAJOR 3: a nullish installedSkills is dereferenced safely', () => {
    // `{...null}` spreads to `{}` and every ad-hoc truthiness guard in this
    // repo short-circuits on null — both true, and both the wrong operation.
    // Consumers SUBSCRIPT, which throws on null exactly as it does on
    // undefined. These drive the real consumer rather than re-measuring the
    // spread.
    const nullish: Array<{ label: string; contents: string }> = [
      { label: 'installedSkills: null', contents: '{"version":"1.0.0","installedSkills":null}' },
      { label: 'installedSkills absent', contents: '{"version":"1.0.0"}' },
    ]

    for (const { label, contents } of nullish) {
      it(`uninstalls normally rather than throwing a TypeError: ${label}`, async () => {
        await fs.writeFile(manifestPath, contents)

        const result = await performUninstall({
          skillName: 'alpha',
          force: false,
          skillsDir,
          manifest: new ManifestManager(manifestPath),
          skillDependencyRepo: stubDependencyRepo,
          onProgress: () => undefined,
        })

        // Asserted on the OUTCOME, not on the absence of a substring: the
        // defect surfaced as `Cannot read properties of null (reading
        // 'alpha')` swallowed by the outer catch into a failed uninstall, so
        // "did not throw" and "succeeded" are the same assertion here and
        // the stronger wording is the honest one.
        expect(result.success).toBe(true)
        expect(result.message).not.toMatch(/Cannot read properties/)
        await expect(fs.access(untrackedSkillDir)).rejects.toMatchObject({ code: 'ENOENT' })
      })
    }
  })
})
