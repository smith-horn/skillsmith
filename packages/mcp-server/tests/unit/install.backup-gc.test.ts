/**
 * Unit tests for SMI-4588 Wave 2 Step 9 — backup garbage collector.
 * PR #4 of the Wave 2 stack.
 *
 * Coverage (per plan §1 "decision #10" + Edit 4):
 *   1. Old backup directory removed; recent backup retained.
 *   2. Malformed-timestamp directory skipped (NOT removed) and surrounding
 *      valid-but-expired entries still GC'd.
 *   3. Missing backups root → no-op success (no throw).
 *   4. Concurrent runs idempotent — second invocation completes without
 *      throwing on already-removed directories.
 *   5. `.original` directory is preserved (carve-out matching
 *      `cleanupOldBackups` in install.conflict-helpers.ts).
 *   6. Retention env clamping — value > 365 clamped to 365; < 1 clamped to 1.
 *   7. Custom `retentionDays` option overrides env.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { runBackupGC } from '../../src/tools/install.backup-gc.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined
let ORIGINAL_RETENTION: string | undefined
let BACKUPS_ROOT: string

const MS_PER_DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-backup-gc-'))
  ORIGINAL_HOME = process.env['HOME']
  ORIGINAL_RETENTION = process.env['SKILLSMITH_BACKUP_RETENTION_DAYS']
  process.env['HOME'] = TEST_HOME
  delete process.env['SKILLSMITH_BACKUP_RETENTION_DAYS']
  BACKUPS_ROOT = path.join(TEST_HOME, '.claude', 'skills', '.backups')
})

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) {
    process.env['HOME'] = ORIGINAL_HOME
  } else {
    delete process.env['HOME']
  }
  if (ORIGINAL_RETENTION !== undefined) {
    process.env['SKILLSMITH_BACKUP_RETENTION_DAYS'] = ORIGINAL_RETENTION
  } else {
    delete process.env['SKILLSMITH_BACKUP_RETENTION_DAYS']
  }
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/**
 * Build a backup leaf directory matching `createSkillBackup`'s naming:
 * `<getBackupsDir()>/<skillName>/<ISO-with-:.replaced-with->_<reason>/`.
 */
function makeBackup(skillName: string, when: Date, reason: string): string {
  const ts = when.toISOString().replace(/[:.]/g, '-')
  const dir = path.join(BACKUPS_ROOT, skillName, `${ts}_${reason}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# backed up\n', 'utf-8')
  return dir
}

describe('runBackupGC', () => {
  it('removes old backup, retains recent backup (case 1)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldWhen = new Date(now.getTime() - 30 * MS_PER_DAY)
    const recentWhen = new Date(now.getTime() - 1 * MS_PER_DAY)
    const oldDir = makeBackup('anthropic-ship', oldWhen, 'namespace-rename')
    const recentDir = makeBackup('anthropic-ship', recentWhen, 'namespace-rename')

    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 14, now })

    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(result.skipped).toBe(0)
    expect(fs.existsSync(oldDir)).toBe(false)
    expect(fs.existsSync(recentDir)).toBe(true)
  })

  it('skips malformed-timestamp directories without removing them; valid expired entries still GC (case 2 — Edit 4 explicit edge)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldWhen = new Date(now.getTime() - 60 * MS_PER_DAY)
    const oldDir = makeBackup('anthropic-ship', oldWhen, 'namespace-rename')

    // Malformed: no timestamp prefix at all.
    const malformed1 = path.join(BACKUPS_ROOT, 'anthropic-ship', 'notatimestamp_reason')
    fs.mkdirSync(malformed1, { recursive: true })
    fs.writeFileSync(path.join(malformed1, 'SKILL.md'), 'manual user dir\n', 'utf-8')
    // Malformed: empty timestamp prefix (`_no-timestamp`).
    const malformed2 = path.join(BACKUPS_ROOT, 'anthropic-ship', '_no-timestamp')
    fs.mkdirSync(malformed2, { recursive: true })
    // Malformed: missing `_<reason>` separator entirely.
    const malformed3 = path.join(BACKUPS_ROOT, 'anthropic-ship', '2026-04-01T15-42-18-331Z')
    fs.mkdirSync(malformed3, { recursive: true })

    // Suppress the expected console.warn lines.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 14, now })

    expect(result.removed).toBe(1)
    expect(result.skipped).toBe(3)
    expect(result.kept).toBe(0)
    expect(fs.existsSync(oldDir)).toBe(false)
    expect(fs.existsSync(malformed1)).toBe(true)
    expect(fs.existsSync(malformed2)).toBe(true)
    expect(fs.existsSync(malformed3)).toBe(true)
    // At least one warn fired per malformed dir.
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns no-op success when backup root does not exist (case 3)', async () => {
    // No filesystem state created — backups dir missing.
    const missing = path.join(TEST_HOME, 'nope', '.backups')
    const result = await runBackupGC({ backupsDir: missing, retentionDays: 14 })
    expect(result).toEqual({ removed: 0, kept: 0, skipped: 0 })
  })

  it('is idempotent on repeat invocation (case 4)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldWhen = new Date(now.getTime() - 30 * MS_PER_DAY)
    makeBackup('anthropic-ship', oldWhen, 'namespace-rename')

    const first = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 14, now })
    expect(first.removed).toBe(1)

    // Second run finds no expired entries — clean state.
    const second = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 14, now })
    expect(second.removed).toBe(0)
    expect(second.kept).toBe(0)
    expect(second.skipped).toBe(0)
  })

  it('preserves the .original directory regardless of age (case 5)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldWhen = new Date(now.getTime() - 90 * MS_PER_DAY)
    // Plant an `.original` directory (used by storeOriginal()).
    const originalDir = path.join(BACKUPS_ROOT, 'anthropic-ship', '.original')
    fs.mkdirSync(originalDir, { recursive: true })
    fs.writeFileSync(path.join(originalDir, 'SKILL.md'), '# pristine\n')
    // And one expired entry to confirm the sweep still runs.
    const expired = makeBackup('anthropic-ship', oldWhen, 'namespace-rename')

    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 14, now })

    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1) // .original counted as kept
    expect(fs.existsSync(originalDir)).toBe(true)
    expect(fs.existsSync(expired)).toBe(false)
  })

  it('clamps retention env value to [1, 365] (case 6)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    // Backup is 400 days old — outside the upper bound (365).
    const veryOld = new Date(now.getTime() - 400 * MS_PER_DAY)
    const dir = makeBackup('anthropic-ship', veryOld, 'namespace-rename')

    process.env['SKILLSMITH_BACKUP_RETENTION_DAYS'] = '99999'
    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, now })
    // Clamped to 365 days; backup is older → removed.
    expect(result.removed).toBe(1)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('respects custom `retentionDays` option over env (case 7)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldWhen = new Date(now.getTime() - 5 * MS_PER_DAY)
    const dir = makeBackup('anthropic-ship', oldWhen, 'namespace-rename')

    // Env says 30 days; option override says 1 day → 5-day-old should GC.
    process.env['SKILLSMITH_BACKUP_RETENTION_DAYS'] = '30'
    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, retentionDays: 1, now })
    expect(result.removed).toBe(1)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('uses default 14-day retention when env unset (case 8)', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z')
    // 13 days old — within default window.
    const within = makeBackup(
      'anthropic-ship',
      new Date(now.getTime() - 13 * MS_PER_DAY),
      'namespace-rename'
    )
    // 15 days old — outside default window.
    const outside = makeBackup(
      'anthropic-ship',
      new Date(now.getTime() - 15 * MS_PER_DAY),
      'namespace-rename'
    )

    const result = await runBackupGC({ backupsDir: BACKUPS_ROOT, now })
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(fs.existsSync(within)).toBe(true)
    expect(fs.existsSync(outside)).toBe(false)

    // Defensive: make sure the writer's path matches what the GC scans.
    // (Plan §"Critical surface ground-truth": the canonical
    // ~/.claude/skills/.backups path.)
    await fsp.access(BACKUPS_ROOT)
  })
})
