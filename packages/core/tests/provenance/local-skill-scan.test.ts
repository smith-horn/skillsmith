/**
 * @see SMI-5407 — local skill enumeration guard
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { scanLocalSkills, isBackupDir } from '../../src/provenance/local-skill-scan.js'

let root = ''

function writeSkill(name: string, content = '---\nname: x\n---\nbody'): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('scanLocalSkills', () => {
  it('lists real skills, flags backups, excludes dotdirs and SKILL.md-less dirs', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-scan-'))
    writeSkill('linear', '---\nname: linear\nauthor: smith-horn\n---\nbody')

    // Backup dir: listed but not scanned.
    const backupName = 'linear.backup-20260419-124019'
    fs.mkdirSync(path.join(root, backupName), { recursive: true })
    fs.writeFileSync(path.join(root, backupName, 'SKILL.md'), 'snapshot')

    // Dotdir: excluded entirely.
    fs.mkdirSync(path.join(root, '.backups'), { recursive: true })

    // Dir without SKILL.md: excluded.
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true })

    const entries = await scanLocalSkills(root)
    const byName = new Map(entries.map((e) => [e.skillName, e]))

    expect(byName.has('.backups')).toBe(false)
    expect(byName.has('empty-dir')).toBe(false)

    const linear = byName.get('linear')
    expect(linear).toBeDefined()
    expect(linear!.isBackup).toBe(false)
    expect(linear!.frontmatterName).toBe('linear')
    expect(linear!.frontmatterAuthor).toBe('smith-horn')
    expect(linear!.skillMd).toContain('body')

    const backup = byName.get(backupName)
    expect(backup).toBeDefined()
    expect(backup!.isBackup).toBe(true)
    expect(backup!.skillMd).toBeNull()
  })

  it('returns [] for an absent root', async () => {
    expect(await scanLocalSkills(path.join(os.tmpdir(), 'prov-does-not-exist-xyz'))).toEqual([])
  })

  // SMI-6532 A2 §4.2 / SMI-6358: ActivationManager.ts:329 creates
  // `${installPath}.backup-${Date.now()}` — a bare epoch-ms suffix with no
  // internal hyphen. The original `/\.backup-\d{8}-/` never matched this
  // shape, so this backup directory was enumerated as an ordinary skill
  // instead of being flagged `isBackup`. Seen failing against the unfixed
  // narrow regex before the fix landed (SMI-6598).
  it('flags an ActivationManager-style backup dir (bare Date.now() suffix, no hyphen)', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-scan-'))
    const backupName = 'linear.backup-1758600000000'
    fs.mkdirSync(path.join(root, backupName), { recursive: true })
    fs.writeFileSync(path.join(root, backupName, 'SKILL.md'), 'snapshot')

    const entries = await scanLocalSkills(root)
    const backup = entries.find((e) => e.skillName === backupName)

    expect(backup).toBeDefined()
    expect(backup!.isBackup).toBe(true)
    expect(backup!.skillMd).toBeNull()
  })
})

describe('isBackupDir', () => {
  it('matches both live backup-dir naming shapes', () => {
    // Known-positive: the documented YYYYMMDD-HHMMSS shape.
    expect(isBackupDir('linear.backup-20260419-124019')).toBe(true)
    // Known-positive: ActivationManager.ts:329's bare Date.now() shape.
    expect(isBackupDir('x.backup-1758600000000')).toBe(true)
    // A shape with digits but no trailing hyphen segment.
    expect(isBackupDir('y.backup-20260419')).toBe(true)
  })

  it('rejects a known-negative control and a skill legitimately named *.backup-<non-digits>', () => {
    // Known-negative control.
    expect(isBackupDir('plain-skill')).toBe(false)
    // A false positive here would silently hide a real skill from updates
    // (see the predicate's own doc comment on failure direction) — a
    // non-digit suffix must never match.
    expect(isBackupDir('my.backup-notes')).toBe(false)
  })
})
