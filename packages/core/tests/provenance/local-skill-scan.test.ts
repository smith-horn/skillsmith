/**
 * @see SMI-5407 — local skill enumeration guard
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { scanLocalSkills } from '../../src/provenance/local-skill-scan.js'

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
})
