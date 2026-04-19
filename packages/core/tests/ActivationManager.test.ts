/**
 * ActivationManager tests (SMI-4290 / closes #598)
 *
 * Covers the public API of `@skillsmith/core/activation/ActivationManager`:
 *   - activateSkill (validation, idempotency, force reinstall, filesystem state)
 *   - undo (rollback of fresh install, rollback of force reinstall via backup)
 *   - getUndoHistory / clearUndoHistory
 *   - Cross-instance persistence via shared `skillsDir`
 *
 * Uses real-tmpdir fixtures (no memfs, no msw — per Wave 3 plan).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { ActivationManager } from '../src/activation/ActivationManager.js'

function makeTmpSkillsDir(): string {
  return path.join(
    tmpdir(),
    `skillsmith-activation-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

describe('ActivationManager', () => {
  let skillsDir: string
  let manager: ActivationManager

  beforeEach(() => {
    skillsDir = makeTmpSkillsDir()
    manager = new ActivationManager(skillsDir)
  })

  afterEach(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('activateSkill — happy path', () => {
    it('activates a valid skill, creates the install directory, and returns an undo token', async () => {
      const result = await manager.activateSkill({ skill_id: 'anthropic/commit' })

      expect(result.success).toBe(true)
      expect(result.skill_id).toBe('anthropic/commit')
      expect(result.undo_token).toBeTruthy()
      expect(result.install_path).toBe(path.join(skillsDir, 'anthropic-commit'))
      expect(result.activation_time_ms).toBeGreaterThanOrEqual(0)

      // Filesystem side effects.
      expect(await exists(result.install_path!)).toBe(true)
      const skillMd = await fs.readFile(path.join(result.install_path!, 'SKILL.md'), 'utf-8')
      expect(skillMd).toContain('anthropic/commit')
    })

    it('returns requires_restart: false when hot_reload succeeds', async () => {
      const result = await manager.activateSkill({
        skill_id: 'anthropic/commit',
        hot_reload: true,
      })

      expect(result.success).toBe(true)
      expect(result.requires_restart).toBe(false)
    })
  })

  describe('activateSkill — already installed', () => {
    it('is idempotent when the skill is already installed and force is false', async () => {
      const first = await manager.activateSkill({ skill_id: 'anthropic/commit' })
      expect(first.success).toBe(true)

      const second = await manager.activateSkill({ skill_id: 'anthropic/commit' })

      expect(second.success).toBe(true)
      expect(second.requires_restart).toBe(false)
      expect(second.install_path).toBe(first.install_path)
      // Idempotent path returns no new undo token.
      expect(second.undo_token).toBeUndefined()
    })

    it('creates a timestamped backup on force-reinstall; undo restores the original install from the backup', async () => {
      const first = await manager.activateSkill({ skill_id: 'anthropic/commit' })
      expect(first.success).toBe(true)

      // Mark the original install with a sentinel so we can confirm a backup was made.
      const sentinel = path.join(first.install_path!, 'sentinel.txt')
      await fs.writeFile(sentinel, 'original-install', 'utf-8')

      const second = await manager.activateSkill({
        skill_id: 'anthropic/commit',
        force: true,
      })
      expect(second.success).toBe(true)
      expect(second.undo_token).toBeTruthy()

      // The fresh install has overwritten the sentinel.
      expect(await exists(sentinel)).toBe(false)

      // Sanity: a backup directory exists alongside the install, preserving the
      // sentinel. This is the pre-undo state created by `createBackup`.
      const entries = await fs.readdir(skillsDir)
      const backupDir = entries.find((e) => e.startsWith('anthropic-commit.backup-'))
      expect(backupDir).toBeTruthy()
      expect(await exists(path.join(skillsDir, backupDir!, 'sentinel.txt'))).toBe(true)

      // Undo of a force-reinstall RESTORES the original install from the backup
      // (SMI-4297). The snapshot now carries `backup_path`, so `undo()` renames
      // the backup back over the install path instead of just deleting it.
      const undone = await manager.undo(second.undo_token!)
      expect(undone).toBe(true)

      // The original install path exists with the original sentinel content.
      expect(await exists(second.install_path!)).toBe(true)
      expect(await exists(sentinel)).toBe(true)
      const sentinelContent = await fs.readFile(sentinel, 'utf-8')
      expect(sentinelContent).toBe('original-install')

      // The backup dir has been consumed (renamed back into place).
      const afterEntries = await fs.readdir(skillsDir)
      expect(afterEntries.some((e) => e.startsWith('anthropic-commit.backup-'))).toBe(false)
    })

    it('undo of force-reinstall restores the original install from its backup', async () => {
      const first = await manager.activateSkill({ skill_id: 'anthropic/commit' })
      expect(first.success).toBe(true)

      // Write an identifying marker in the original install.
      const marker = path.join(first.install_path!, 'marker.txt')
      await fs.writeFile(marker, 'v1-original', 'utf-8')

      const second = await manager.activateSkill({
        skill_id: 'anthropic/commit',
        force: true,
      })
      expect(second.success).toBe(true)
      expect(second.undo_token).toBeTruthy()

      // Fresh install has overwritten the marker.
      expect(await exists(marker)).toBe(false)

      // Undo restores the v1 marker by moving the backup back.
      const ok = await manager.undo(second.undo_token!)
      expect(ok).toBe(true)
      expect(await exists(marker)).toBe(true)
      expect(await fs.readFile(marker, 'utf-8')).toBe('v1-original')
    })
  })

  describe('activateSkill — validation failures', () => {
    it('rejects an empty skill_id with a typed validation error', async () => {
      const result = await manager.activateSkill({ skill_id: '' })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Validation failed/i)
      expect(result.requires_restart).toBe(false)
      expect(result.undo_token).toBeUndefined()
    })

    it('rejects a skill_id missing the author/name separator', async () => {
      const result = await manager.activateSkill({ skill_id: 'just-a-name' })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/format "author\/name"/i)
    })

    it('rejects a skill_id containing invalid characters', async () => {
      const result = await manager.activateSkill({
        skill_id: 'bad author/bad name',
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/invalid characters/i)
    })

    it('skips validation when validate_first is false', async () => {
      const result = await manager.activateSkill({
        skill_id: 'anthropic/commit',
        validate_first: false,
      })

      expect(result.success).toBe(true)
      expect(result.install_path).toBeTruthy()
    })
  })

  describe('undo — fresh install', () => {
    it('removes the install directory and forgets the token', async () => {
      const result = await manager.activateSkill({ skill_id: 'anthropic/commit' })
      expect(result.success).toBe(true)
      expect(await exists(result.install_path!)).toBe(true)

      const undone = await manager.undo(result.undo_token!)

      expect(undone).toBe(true)
      expect(await exists(result.install_path!)).toBe(false)

      // Undoing a second time with the same token is a no-op (snapshot is gone).
      const second = await manager.undo(result.undo_token!)
      expect(second).toBe(false)
    })

    it('returns false for an unknown undo token', async () => {
      const undone = await manager.undo('does-not-exist')
      expect(undone).toBe(false)
    })
  })

  describe('undo history', () => {
    it('tracks snapshots across activations and can be cleared', async () => {
      const a = await manager.activateSkill({ skill_id: 'anthropic/commit' })
      const b = await manager.activateSkill({ skill_id: 'anthropic/review' })
      expect(a.success).toBe(true)
      expect(b.success).toBe(true)

      const history = manager.getUndoHistory()
      expect(history.length).toBe(2)
      const tokens = history.map((h) => h.token).sort()
      expect(tokens).toContain(a.undo_token)
      expect(tokens).toContain(b.undo_token)

      manager.clearUndoHistory()
      expect(manager.getUndoHistory()).toEqual([])

      // After clearing history, previously issued tokens are no longer redeemable.
      const stale = await manager.undo(a.undo_token!)
      expect(stale).toBe(false)
    })
  })

  describe('cross-instance persistence', () => {
    it('sees activations performed by a separate manager sharing the same skillsDir', async () => {
      const managerA = new ActivationManager(skillsDir)
      const activate = await managerA.activateSkill({ skill_id: 'anthropic/commit' })
      expect(activate.success).toBe(true)

      // A brand-new manager on the same skillsDir must treat the skill as installed
      // (idempotent path → success, no undo token).
      const managerB = new ActivationManager(skillsDir)
      const second = await managerB.activateSkill({ skill_id: 'anthropic/commit' })

      expect(second.success).toBe(true)
      expect(second.undo_token).toBeUndefined()
      expect(await exists(path.join(skillsDir, 'anthropic-commit'))).toBe(true)
    })
  })

  describe('concurrency', () => {
    it('activates multiple distinct skills concurrently', async () => {
      const ids = ['anthropic/commit', 'anthropic/review', 'team/lint']

      const results = await Promise.all(ids.map((id) => manager.activateSkill({ skill_id: id })))

      expect(results.every((r) => r.success)).toBe(true)
      for (const id of ids) {
        const dir = path.join(skillsDir, id.replace('/', '-'))
        expect(await exists(dir)).toBe(true)
      }
      expect(manager.getUndoHistory().length).toBe(3)
    })
  })
})
