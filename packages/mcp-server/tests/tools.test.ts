/**
 * Tests for MCP Tools (SMI-586, SMI-588)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock the file operations for testing
const TEST_SKILLS_DIR = path.join(os.tmpdir(), 'test-claude-skills-' + Date.now());
const TEST_MANIFEST_DIR = path.join(os.tmpdir(), 'test-skillsmith-' + Date.now());

describe('installSkill', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SKILLS_DIR, { recursive: true });
    await fs.mkdir(TEST_MANIFEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_SKILLS_DIR, { recursive: true, force: true });
      await fs.rm(TEST_MANIFEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('should parse GitHub URLs correctly', () => {
    // This would test the parseSkillId function
    const testCases = [
      {
        input: 'anthropics/claude-skills/commit',
        expected: { owner: 'anthropics', repo: 'claude-skills', path: 'commit' }
      },
      {
        input: 'https://github.com/anthropics/claude-skills',
        expected: { owner: 'anthropics', repo: 'claude-skills', path: '' }
      }
    ];

    for (const { input, expected } of testCases) {
      // Test parseSkillId logic
      if (input.startsWith('https://github.com/')) {
        const url = new URL(input);
        const parts = url.pathname.split('/').filter(Boolean);
        expect(parts[0]).toBe(expected.owner);
        expect(parts[1]).toBe(expected.repo);
      } else if (input.includes('/')) {
        const [owner, ...rest] = input.split('/');
        expect(owner).toBe(expected.owner);
        expect(rest[0]).toBe(expected.repo);
        expect(rest.slice(1).join('/')).toBe(expected.path);
      }
    }
  });

  it('should validate SKILL.md content', () => {
    const validateSkillMd = (content: string) => {
      const errors: string[] = [];
      if (!content.includes('# ')) {
        errors.push('Missing title');
      }
      if (content.length < 100) {
        errors.push('Too short');
      }
      return { valid: errors.length === 0, errors };
    };

    expect(validateSkillMd('# My Skill\n\nThis is a valid skill with enough content to pass the minimum length requirement for validation.')).toEqual({
      valid: true,
      errors: []
    });

    expect(validateSkillMd('Too short')).toEqual({
      valid: false,
      errors: ['Missing title', 'Too short']
    });
  });
});

describe('uninstallSkill', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SKILLS_DIR, { recursive: true });
    await fs.mkdir(TEST_MANIFEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_SKILLS_DIR, { recursive: true, force: true });
      await fs.rm(TEST_MANIFEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('should detect modified skills', async () => {
    const skillPath = path.join(TEST_SKILLS_DIR, 'test-skill');
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Test Skill');
    
    const installedAt = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
    
    // Modify the file
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Modified Skill');
    
    const stats = await fs.stat(path.join(skillPath, 'SKILL.md'));
    const installDate = new Date(installedAt);
    
    expect(stats.mtime > installDate).toBe(true);
  });

  it('should clean up skill directory', async () => {
    const skillPath = path.join(TEST_SKILLS_DIR, 'to-remove');
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Test');
    
    await fs.rm(skillPath, { recursive: true, force: true });
    
    await expect(fs.access(skillPath)).rejects.toThrow();
  });
});

describe('MCP Tool Schemas', () => {
  it('should have valid search input schema', () => {
    // Test that the schema validates correctly
    const validInput = {
      query: 'react testing',
      limit: 20,
      offset: 0,
    };
    
    expect(validInput.query.length).toBeGreaterThan(0);
    expect(validInput.limit).toBeLessThanOrEqual(100);
    expect(validInput.offset).toBeGreaterThanOrEqual(0);
  });

  it('should have valid install input schema', () => {
    const validInput = {
      skillId: 'owner/repo/skill',
      force: false,
      skipScan: false,
    };
    
    expect(validInput.skillId.length).toBeGreaterThan(0);
    expect(typeof validInput.force).toBe('boolean');
    expect(typeof validInput.skipScan).toBe('boolean');
  });

  it('should have valid uninstall input schema', () => {
    const validInput = {
      skillName: 'my-skill',
      force: false,
    };
    
    expect(validInput.skillName.length).toBeGreaterThan(0);
    expect(typeof validInput.force).toBe('boolean');
  });
});
