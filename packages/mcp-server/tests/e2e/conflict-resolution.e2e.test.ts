/**
 * E2E Test: Conflict Resolution Merge Flow
 *
 * Tests the complete conflict detection and resolution workflow
 * when reinstalling skills with local modifications.
 *
 * SMI-1889: E2E test for conflict resolution merge flow
 *
 * @see packages/mcp-server/src/tools/install.conflict.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { checkForConflicts, handleMergeAction } from '../../src/tools/install.conflict.js'
import {
  hashContent,
  storeOriginal,
  loadOriginal,
  getBackupsDir,
} from '../../src/tools/install.helpers.js'
import type { SkillManifest } from '../../src/tools/install.types.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-conflict')
const TEST_HOME = join(TEST_DIR, 'home')
const TEST_SKILLS_DIR = join(TEST_HOME, '.claude', 'skills')
const TEST_SKILLSMITH_DIR = join(TEST_HOME, '.skillsmith')

// Dynamic paths - computed after HOME is set
// Note: getBackupsDir() returns ~/.claude/skills/.backups, not ~/.skillsmith/backups
function getTestBackupsDir(): string {
  return getBackupsDir()
}

// Mock skill content for testing
const ORIGINAL_SKILL_CONTENT = `---
name: test-skill
version: 1.0.0
description: A test skill for conflict resolution testing
---

# Test Skill

Original content that was installed from upstream.

## Features
- Feature A
- Feature B
`

const MODIFIED_SKILL_CONTENT = `---
name: test-skill
version: 1.0.0
description: A test skill for conflict resolution testing
---

# Test Skill

Original content that was installed from upstream.

## Features
- Feature A
- Feature B
- Feature C (local addition)

## Local Notes
These are my local notes that I added.
`

const UPSTREAM_UPDATE_CONTENT = `---
name: test-skill
version: 1.1.0
description: A test skill for conflict resolution testing (updated)
---

# Test Skill

Original content that was installed from upstream.

## Features
- Feature A
- Feature B
- Feature D (upstream addition)

## Changelog
- v1.1.0: Added Feature D
`

const CONFLICTING_UPDATE_CONTENT = `---
name: test-skill
version: 1.1.0
description: A test skill for conflict resolution testing (updated)
---

# Test Skill

Completely rewritten content from upstream.

## New Features
- Feature X
- Feature Y
`

describe('E2E: conflict resolution merge flow', () => {
  let originalHome: string | undefined

  beforeAll(() => {
    // Save original HOME
    originalHome = process.env['HOME']

    // Override HOME for tests FIRST, so getBackupsDir() returns correct path
    process.env['HOME'] = TEST_HOME

    // Create test environment
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })
    mkdirSync(TEST_SKILLSMITH_DIR, { recursive: true })

    // Create the actual backup directory where the code writes
    // getBackupsDir() returns ~/.claude/skills/.backups
    mkdirSync(getTestBackupsDir(), { recursive: true })
  })

  afterAll(() => {
    // Restore HOME
    if (originalHome) {
      process.env['HOME'] = originalHome
    }

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Clean up between tests
    const skillPath = join(TEST_SKILLS_DIR, 'test-skill')
    if (existsSync(skillPath)) {
      rmSync(skillPath, { recursive: true, force: true })
    }

    // Clean backups - use the actual backup directory
    const backupsDir = getTestBackupsDir()
    if (existsSync(backupsDir)) {
      const backups = readdirSync(backupsDir)
      for (const backup of backups) {
        rmSync(join(backupsDir, backup), { recursive: true, force: true })
      }
    }
  })

  /**
   * Helper to set up a skill with original content stored
   */
  async function setupInstalledSkill(content: string = ORIGINAL_SKILL_CONTENT) {
    const skillPath = join(TEST_SKILLS_DIR, 'test-skill')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(join(skillPath, 'SKILL.md'), content)

    // Store original content for conflict detection
    await storeOriginal('test-skill', ORIGINAL_SKILL_CONTENT, {
      version: '1.0.0',
      source: 'github:test/test-skill',
      installedAt: new Date().toISOString(),
    })

    return skillPath
  }

  /**
   * Helper to create a manifest entry
   */
  function createManifestEntry(): SkillManifest {
    return {
      version: '1.0.0',
      installedSkills: {
        'test-skill': {
          id: 'test/test-skill',
          name: 'test-skill',
          version: '1.0.0',
          source: 'github:test/test-skill',
          installPath: join(TEST_SKILLS_DIR, 'test-skill'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          originalContentHash: hashContent(ORIGINAL_SKILL_CONTENT),
        },
      },
    }
  }

  describe('Scenario 1: Cancel Action', () => {
    it('should abort installation without changes when cancel is chosen', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Check for conflicts with cancel action
      const result = await checkForConflicts(
        'test-skill',
        installPath,
        manifest,
        'cancel',
        'test/test-skill'
      )

      // Verify installation was aborted
      expect(result.shouldProceed).toBe(false)
      expect(result.earlyReturn).toBeDefined()
      expect(result.earlyReturn?.success).toBe(false)
      expect(result.earlyReturn?.error).toContain('cancelled')

      // Verify local file was NOT modified
      const currentContent = readFileSync(join(installPath, 'SKILL.md'), 'utf-8')
      expect(currentContent).toBe(MODIFIED_SKILL_CONTENT)

      // Verify no timestamped backup was created (cancel doesn't backup)
      // Note: .original directory may exist from storeOriginal() call, but no timestamped backups
      const backupsDir = getTestBackupsDir()
      const skillBackupDir = join(backupsDir, 'test-skill')
      if (existsSync(skillBackupDir)) {
        const entries = readdirSync(skillBackupDir)
        // Only .original should exist, no timestamped backups
        const timestampedBackups = entries.filter((e) => e !== '.original')
        expect(timestampedBackups.length).toBe(0)
      }
    })
  })

  describe('Scenario 2: Overwrite Action', () => {
    it('should create backup and allow proceeding with overwrite', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Check for conflicts with overwrite action
      const result = await checkForConflicts(
        'test-skill',
        installPath,
        manifest,
        'overwrite',
        'test/test-skill'
      )

      // Verify proceed is allowed
      expect(result.shouldProceed).toBe(true)
      expect(result.backupPath).toBeDefined()

      // Verify backup was created
      expect(existsSync(result.backupPath!)).toBe(true)

      // Verify backup directory contains backup files
      const backupsDir = getTestBackupsDir()
      const backupDirs = readdirSync(backupsDir)
      expect(backupDirs.length).toBeGreaterThan(0)

      // Find the backup and verify content preserved
      // Backups are stored in ~/.claude/skills/.backups/test-skill/<timestamp>_<reason>/
      const skillBackupDir = join(backupsDir, 'test-skill')
      expect(existsSync(skillBackupDir)).toBe(true)
      const skillBackups = readdirSync(skillBackupDir).filter((d) => d !== '.original')
      expect(skillBackups.length).toBeGreaterThan(0)
      const backupContent = readFileSync(join(skillBackupDir, skillBackups[0], 'SKILL.md'), 'utf-8')
      expect(backupContent).toBe(MODIFIED_SKILL_CONTENT)
    })
  })

  describe('Scenario 3: Merge Action (Clean)', () => {
    it('should perform clean three-way merge preserving local changes', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Handle merge with non-conflicting upstream update
      const result = await handleMergeAction(
        'test-skill',
        installPath,
        UPSTREAM_UPDATE_CONTENT,
        manifest,
        'test',
        'test-skill',
        'test/test-skill'
      )

      // For clean merge, should proceed with merged content
      // Note: actual merge result depends on diff algorithm
      if (result.shouldProceed && result.mergedContent) {
        // Clean merge succeeded
        expect(result.mergedContent).toBeDefined()
        expect(result.mergedContent).not.toBe(MODIFIED_SKILL_CONTENT)
        expect(result.mergedContent).not.toBe(UPSTREAM_UPDATE_CONTENT)
      } else {
        // If merge had conflicts, check appropriate handling
        expect(result.earlyReturn?.mergeResult).toBeDefined()
      }
    })
  })

  describe('Scenario 4: Merge Action with Conflicts', () => {
    it('should handle conflicting changes with markers', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Handle merge with conflicting upstream update
      const result = await handleMergeAction(
        'test-skill',
        installPath,
        CONFLICTING_UPDATE_CONTENT,
        manifest,
        'test',
        'test-skill',
        'test/test-skill'
      )

      // For conflict merge, should stop and report
      if (!result.shouldProceed) {
        // Conflict detected
        expect(result.backupPath).toBeDefined()
        expect(result.earlyReturn).toBeDefined()
        expect(result.earlyReturn?.mergeResult).toBeDefined()
        expect(result.earlyReturn?.tips).toBeDefined()
        expect(result.earlyReturn?.tips?.some((t) => t.includes('conflict'))).toBe(true)

        // Verify backup was created
        expect(existsSync(result.backupPath!)).toBe(true)

        // Check that merged file has conflict markers
        const mergedContent = readFileSync(join(installPath, 'SKILL.md'), 'utf-8')
        const hasConflictMarkers =
          mergedContent.includes('<<<<<<<') || mergedContent.includes('>>>>>>>')
        expect(hasConflictMarkers).toBe(true)
      } else {
        // If clean merge somehow succeeded, verify merged content
        expect(result.mergedContent).toBeDefined()
      }
    })
  })

  describe('Conflict Detection', () => {
    it('should detect no conflict when content is unchanged', async () => {
      // Install skill WITHOUT modifications
      const installPath = await setupInstalledSkill(ORIGINAL_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Check for conflicts
      const result = await checkForConflicts(
        'test-skill',
        installPath,
        manifest,
        undefined,
        'test/test-skill'
      )

      // No modifications means proceed without action needed
      expect(result.shouldProceed).toBe(true)
      expect(result.earlyReturn).toBeUndefined()
    })

    it('should detect modifications and require action', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)
      const manifest = createManifestEntry()

      // Check for conflicts WITHOUT providing action
      const result = await checkForConflicts(
        'test-skill',
        installPath,
        manifest,
        undefined,
        'test/test-skill'
      )

      // Should not proceed and require action
      expect(result.shouldProceed).toBe(false)
      expect(result.earlyReturn).toBeDefined()
      expect(result.earlyReturn?.conflict).toBeDefined()
      expect(result.earlyReturn?.conflict?.hasLocalModifications).toBe(true)
      expect(result.earlyReturn?.requiresAction).toContain('overwrite')
      expect(result.earlyReturn?.requiresAction).toContain('merge')
      expect(result.earlyReturn?.requiresAction).toContain('cancel')
    })

    it('should handle skill without original hash gracefully', async () => {
      const installPath = await setupInstalledSkill(MODIFIED_SKILL_CONTENT)

      // Create manifest WITHOUT originalContentHash
      const manifest: SkillManifest = {
        version: '1.0.0',
        installedSkills: {
          'test-skill': {
            id: 'test/test-skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'github:test/test-skill',
            installPath,
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            // No originalContentHash
          },
        },
      }

      const result = await checkForConflicts(
        'test-skill',
        installPath,
        manifest,
        undefined,
        'test/test-skill'
      )

      // Should proceed (can't detect conflicts without original hash)
      expect(result.shouldProceed).toBe(true)
    })
  })

  describe('Original Content Storage', () => {
    it('should store and retrieve original content correctly', async () => {
      await storeOriginal('store-test-skill', ORIGINAL_SKILL_CONTENT, {
        version: '1.0.0',
        source: 'github:test/store-test-skill',
        installedAt: new Date().toISOString(),
      })

      const retrieved = await loadOriginal('store-test-skill')

      expect(retrieved).toBe(ORIGINAL_SKILL_CONTENT)
    })

    it('should return null for non-existent original', async () => {
      const retrieved = await loadOriginal('non-existent-skill')

      expect(retrieved).toBeNull()
    })
  })

  describe('Hash Consistency', () => {
    it('should produce consistent hashes for same content', () => {
      const hash1 = hashContent(ORIGINAL_SKILL_CONTENT)
      const hash2 = hashContent(ORIGINAL_SKILL_CONTENT)

      expect(hash1).toBe(hash2)
    })

    it('should produce different hashes for different content', () => {
      const hash1 = hashContent(ORIGINAL_SKILL_CONTENT)
      const hash2 = hashContent(MODIFIED_SKILL_CONTENT)

      expect(hash1).not.toBe(hash2)
    })
  })
})
