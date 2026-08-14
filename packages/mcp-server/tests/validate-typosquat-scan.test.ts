/**
 * SMI-6033 Wave 1 (Gap 7): scanTyposquatName — skill_validate's offline
 * typosquat check against the bundled release-time snapshot. Pure (no
 * ToolContext/DB/network) — exercises the real detectTyposquat() against a
 * temporary snapshot file, mirroring validate-bundled-scan.test.ts's pattern
 * of testing against real state rather than mocking fs.
 *
 * scanTyposquatName caches the loaded snapshot at module scope (a deliberate
 * production optimization — the snapshot is a release-time asset, not
 * something that changes mid-process). Each test below uses
 * vi.resetModules() + a fresh dynamic import to get an uncached module
 * instance, so tests can exercise different snapshot contents without
 * fighting that cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'assets', 'typosquat-reference-snapshot.json')
const BACKUP_PATH = `${SNAPSHOT_PATH}.smi6033-test-backup`

async function importFresh() {
  vi.resetModules()
  const { scanTyposquatName } = await import('../src/tools/validate-typosquat-scan.js')
  return scanTyposquatName as (skillName: string | undefined) => unknown[]
}

describe('scanTyposquatName (SMI-6033 Wave 1, Gap 7)', () => {
  const hadOriginal = existsSync(SNAPSHOT_PATH)

  beforeEach(() => {
    if (hadOriginal) copyFileSync(SNAPSHOT_PATH, BACKUP_PATH)
  })

  afterEach(() => {
    if (hadOriginal) {
      copyFileSync(BACKUP_PATH, SNAPSHOT_PATH)
      unlinkSync(BACKUP_PATH)
    }
  })

  function writeSnapshot(names: string[]): void {
    writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify({
        generatedAt: '2026-08-14T00:00:00.000Z',
        source: 'skills.stars+high-trust',
        names,
      }),
      'utf-8'
    )
  }

  it('returns [] when the skill name is undefined or blank', async () => {
    writeSnapshot(['anthropic'])
    const scanTyposquatName = await importFresh()
    expect(scanTyposquatName(undefined)).toHaveLength(0)
    expect(scanTyposquatName('   ')).toHaveLength(0)
  })

  it('returns [] when the bundled snapshot has no names (unwritten placeholder)', async () => {
    writeSnapshot([])
    const scanTyposquatName = await importFresh()
    expect(scanTyposquatName('anthropc')).toHaveLength(0)
  })

  it('returns [] for a name that is not close to any reference name', async () => {
    writeSnapshot(['anthropic', 'openai'])
    const scanTyposquatName = await importFresh()
    expect(scanTyposquatName('my-cool-widget-helper')).toHaveLength(0)
  })

  it('flags a warning-severity finding for a one-edit-distance typosquat', async () => {
    writeSnapshot(['anthropic'])
    const scanTyposquatName = await importFresh()
    const errors = scanTyposquatName('anthropc') as Array<{
      field: string
      severity: string
      message: string
    }>
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].field).toBe('name')
    expect(errors[0].severity).toBe('warning')
    expect(errors[0].message).toContain('Possible typosquat')
  })

  it('degrades to no findings (never throws) when the snapshot file is missing', async () => {
    if (existsSync(SNAPSHOT_PATH)) unlinkSync(SNAPSHOT_PATH)
    const scanTyposquatName = await importFresh()
    expect(() => scanTyposquatName('anthropc')).not.toThrow()
    expect(scanTyposquatName('anthropc')).toHaveLength(0)
  })

  it('degrades to no findings (never throws) when the snapshot is malformed JSON', async () => {
    writeFileSync(SNAPSHOT_PATH, '{ not valid json ', 'utf-8')
    const scanTyposquatName = await importFresh()
    expect(() => scanTyposquatName('anthropc')).not.toThrow()
    expect(scanTyposquatName('anthropc')).toHaveLength(0)
  })
})
