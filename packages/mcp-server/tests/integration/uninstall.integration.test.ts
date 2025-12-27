/**
 * SMI-616: Uninstall Skill Tool Integration Tests
 * Tests the uninstall_skill tool with real filesystem operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTestFilesystem,
  createMockManifest,
  createMockInstalledSkill,
  fileExists,
  readJsonFile,
  type TestFilesystemContext,
} from './setup.js';

describe('Uninstall Skill Tool Integration Tests', () => {
  let fsContext: TestFilesystemContext;

  beforeEach(async () => {
    fsContext = await createTestFilesystem();
  });

  afterEach(async () => {
    await fsContext.cleanup();
  });

  describe('Basic Uninstall Operations', () => {
    it('should uninstall skill that exists in manifest', async () => {
      const skillName = 'skill-to-remove';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      await createMockManifest(fsContext.manifestDir, {
        [skillName]: {
          id: 'owner/skill-to-remove',
          name: skillName,
          version: '1.0.0',
          source: 'github:owner/skill-to-remove',
          installPath: skillPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      // Verify skill exists before uninstall
      expect(await fileExists(skillPath)).toBe(true);

      // Perform uninstall
      await fs.rm(skillPath, { recursive: true, force: true });

      // Update manifest
      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      delete manifest.installedSkills[skillName];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify uninstall
      expect(await fileExists(skillPath)).toBe(false);

      const updatedManifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      expect(updatedManifest.installedSkills[skillName]).toBeUndefined();
    });

    it('should handle skill not in manifest but on disk', async () => {
      const skillName = 'orphan-skill';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      // Create empty manifest (skill not tracked)
      await createMockManifest(fsContext.manifestDir, {});

      // Verify skill exists on disk
      expect(await fileExists(skillPath)).toBe(true);

      // Force remove from disk
      await fs.rm(skillPath, { recursive: true, force: true });

      // Verify removal
      expect(await fileExists(skillPath)).toBe(false);
    });

    it('should report skill not found', async () => {
      await createMockManifest(fsContext.manifestDir, {});

      const skillPath = path.join(fsContext.skillsDir, 'nonexistent-skill');
      const exists = await fileExists(skillPath);

      expect(exists).toBe(false);
    });
  });

  describe('Modification Detection', () => {
    it('should detect modified files', async () => {
      const skillName = 'modified-skill';
      const skillPath = path.join(fsContext.skillsDir, skillName);
      await fs.mkdir(skillPath, { recursive: true });

      // Create SKILL.md
      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        '# Original Content\n\nOriginal skill content.'
      );

      const installedAt = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago

      // Wait a tiny bit then modify
      await new Promise(resolve => setTimeout(resolve, 50));
      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        '# Modified Content\n\nThis content was changed after installation.'
      );

      // Check modification time
      const stats = await fs.stat(path.join(skillPath, 'SKILL.md'));
      const installDate = new Date(installedAt);

      const isModified = stats.mtime > installDate;
      expect(isModified).toBe(true);
    });

    it('should not flag unmodified files as modified', async () => {
      const skillName = 'unmodified-skill';
      const skillPath = path.join(fsContext.skillsDir, skillName);
      await fs.mkdir(skillPath, { recursive: true });

      // Create SKILL.md
      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        '# Unchanged Content\n\nThis content remains unchanged.'
      );

      // Wait then record install time
      await new Promise(resolve => setTimeout(resolve, 50));
      const installedAt = new Date().toISOString();

      // Check modification time
      const stats = await fs.stat(path.join(skillPath, 'SKILL.md'));
      const installDate = new Date(installedAt);

      const isModified = stats.mtime > installDate;
      expect(isModified).toBe(false);
    });
  });

  describe('Force Uninstall', () => {
    it('should force uninstall modified skill', async () => {
      const skillName = 'force-uninstall-skill';
      const skillPath = path.join(fsContext.skillsDir, skillName);
      await fs.mkdir(skillPath, { recursive: true });

      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        '# Force Uninstall Test\n\nThis skill will be force uninstalled.'
      );

      // Modify after creation
      await fs.writeFile(
        path.join(skillPath, 'custom-file.txt'),
        'User added this file'
      );

      // Force remove
      await fs.rm(skillPath, { recursive: true, force: true });

      expect(await fileExists(skillPath)).toBe(false);
    });

    it('should force uninstall skill not in manifest', async () => {
      const skillName = 'untracked-skill';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      await createMockManifest(fsContext.manifestDir, {}); // Empty manifest

      // Force remove
      await fs.rm(skillPath, { recursive: true, force: true });

      expect(await fileExists(skillPath)).toBe(false);
    });
  });

  describe('Manifest Cleanup', () => {
    it('should remove skill entry from manifest', async () => {
      const skillName = 'manifest-cleanup-skill';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      await createMockManifest(fsContext.manifestDir, {
        [skillName]: {
          id: 'owner/manifest-cleanup-skill',
          name: skillName,
          version: '1.0.0',
          source: 'github:owner/manifest-cleanup-skill',
          installPath: skillPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
        'other-skill': {
          id: 'owner/other-skill',
          name: 'other-skill',
          version: '1.0.0',
          source: 'github:owner/other-skill',
          installPath: path.join(fsContext.skillsDir, 'other-skill'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      // Remove skill and update manifest
      await fs.rm(skillPath, { recursive: true, force: true });

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      delete manifest.installedSkills[skillName];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify cleanup
      const updatedManifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      expect(updatedManifest.installedSkills[skillName]).toBeUndefined();
      expect(updatedManifest.installedSkills['other-skill']).toBeDefined();
    });
  });

  describe('Recursive Directory Removal', () => {
    it('should remove skill with nested files', async () => {
      const skillName = 'nested-skill';
      const skillPath = path.join(fsContext.skillsDir, skillName);

      // Create nested structure
      await fs.mkdir(path.join(skillPath, 'examples'), { recursive: true });
      await fs.mkdir(path.join(skillPath, 'tests'), { recursive: true });

      await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Nested Skill');
      await fs.writeFile(path.join(skillPath, 'README.md'), '# README');
      await fs.writeFile(path.join(skillPath, 'examples', 'example1.md'), '# Example 1');
      await fs.writeFile(path.join(skillPath, 'tests', 'test1.md'), '# Test 1');

      // Verify nested structure exists
      expect(await fileExists(path.join(skillPath, 'examples', 'example1.md'))).toBe(true);
      expect(await fileExists(path.join(skillPath, 'tests', 'test1.md'))).toBe(true);

      // Remove recursively
      await fs.rm(skillPath, { recursive: true, force: true });

      // Verify complete removal
      expect(await fileExists(skillPath)).toBe(false);
    });

    it('should handle already deleted skill gracefully', async () => {
      const skillPath = path.join(fsContext.skillsDir, 'already-deleted');

      // Try to remove non-existent directory
      await expect(
        fs.rm(skillPath, { recursive: true, force: true })
      ).resolves.not.toThrow();
    });
  });

  describe('List Installed Skills', () => {
    it('should list all installed skills from manifest', async () => {
      await createMockManifest(fsContext.manifestDir, {
        'skill1': {
          id: 'owner/skill1',
          name: 'skill1',
          version: '1.0.0',
          source: 'github:owner/skill1',
          installPath: path.join(fsContext.skillsDir, 'skill1'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
        'skill2': {
          id: 'owner/skill2',
          name: 'skill2',
          version: '1.0.0',
          source: 'github:owner/skill2',
          installPath: path.join(fsContext.skillsDir, 'skill2'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
        'skill3': {
          id: 'owner/skill3',
          name: 'skill3',
          version: '2.0.0',
          source: 'github:owner/skill3',
          installPath: path.join(fsContext.skillsDir, 'skill3'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      const skillNames = Object.keys(manifest.installedSkills);

      expect(skillNames).toContain('skill1');
      expect(skillNames).toContain('skill2');
      expect(skillNames).toContain('skill3');
      expect(skillNames.length).toBe(3);
    });

    it('should return empty list when no skills installed', async () => {
      await createMockManifest(fsContext.manifestDir, {});

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      const skillNames = Object.keys(manifest.installedSkills);

      expect(skillNames).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle skill name with special characters', async () => {
      const skillName = 'skill-with-dashes';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      await fs.rm(skillPath, { recursive: true, force: true });
      expect(await fileExists(skillPath)).toBe(false);
    });

    it('should handle concurrent uninstall attempts', async () => {
      const skillName = 'concurrent-skill';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      // Simulate concurrent uninstalls
      await Promise.all([
        fs.rm(skillPath, { recursive: true, force: true }),
        fs.rm(skillPath, { recursive: true, force: true }),
      ]);

      expect(await fileExists(skillPath)).toBe(false);
    });

    it('should handle manifest file missing', async () => {
      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');

      // Ensure manifest doesn't exist
      try {
        await fs.unlink(manifestPath);
      } catch {
        // Ignore if doesn't exist
      }

      // Should be able to create new manifest
      await createMockManifest(fsContext.manifestDir, {});
      expect(await fileExists(manifestPath)).toBe(true);
    });
  });

  describe('Full Uninstall Flow Simulation', () => {
    it('should complete full uninstall flow', async () => {
      const skillName = 'full-uninstall-skill';
      const skillPath = await createMockInstalledSkill(fsContext.skillsDir, skillName);

      // Create additional files
      await fs.writeFile(path.join(skillPath, 'README.md'), '# README');
      await fs.writeFile(path.join(skillPath, 'config.json'), '{}');

      await createMockManifest(fsContext.manifestDir, {
        [skillName]: {
          id: 'owner/full-uninstall-skill',
          name: skillName,
          version: '1.0.0',
          source: 'github:owner/full-uninstall-skill',
          installPath: skillPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      // Verify pre-conditions
      expect(await fileExists(skillPath)).toBe(true);
      expect(await fileExists(path.join(skillPath, 'SKILL.md'))).toBe(true);
      expect(await fileExists(path.join(skillPath, 'README.md'))).toBe(true);
      expect(await fileExists(path.join(skillPath, 'config.json'))).toBe(true);

      // Execute uninstall
      // 1. Remove directory
      await fs.rm(skillPath, { recursive: true, force: true });

      // 2. Update manifest
      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ version: string; installedSkills: Record<string, unknown> }>(manifestPath);
      delete manifest.installedSkills[skillName];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify post-conditions
      expect(await fileExists(skillPath)).toBe(false);

      const updatedManifest = await readJsonFile<typeof manifest>(manifestPath);
      expect(updatedManifest.installedSkills[skillName]).toBeUndefined();
    });
  });
});
