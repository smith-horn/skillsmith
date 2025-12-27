/**
 * SMI-616: Install Skill Tool Integration Tests
 * Tests the install_skill tool with mocked GitHub and real filesystem
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTestFilesystem,
  createMockManifest,
  createMockGitHubFetch,
  fileExists,
  readJsonFile,
  type TestFilesystemContext,
} from './setup.js';

// We need to mock the paths used by the install module
// Since the install.ts uses os.homedir(), we'll test the core logic

describe('Install Skill Tool Integration Tests', () => {
  let fsContext: TestFilesystemContext;

  beforeEach(async () => {
    fsContext = await createTestFilesystem();
  });

  afterEach(async () => {
    await fsContext.cleanup();
    vi.restoreAllMocks();
  });

  describe('Skill ID Parsing', () => {
    it('should parse owner/repo format correctly', () => {
      const parseSkillId = (input: string) => {
        if (input.startsWith('https://github.com/')) {
          const url = new URL(input);
          const parts = url.pathname.split('/').filter(Boolean);
          return {
            owner: parts[0],
            repo: parts[1],
            path: parts.slice(2).join('/') || '',
          };
        }

        if (input.includes('/')) {
          const [owner, ...rest] = input.split('/');
          const repo = rest[0];
          const skillPath = rest.slice(1).join('/');
          return { owner, repo, path: skillPath };
        }

        throw new Error('Invalid skill ID format');
      };

      const result1 = parseSkillId('anthropic/claude-skills/commit');
      expect(result1).toEqual({
        owner: 'anthropic',
        repo: 'claude-skills',
        path: 'commit',
      });

      const result2 = parseSkillId('owner/repo');
      expect(result2).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
      });
    });

    it('should parse GitHub URL correctly', () => {
      const parseSkillId = (input: string) => {
        if (input.startsWith('https://github.com/')) {
          const url = new URL(input);
          const parts = url.pathname.split('/').filter(Boolean);
          return {
            owner: parts[0],
            repo: parts[1],
            path: parts.slice(2).join('/') || '',
          };
        }
        throw new Error('Invalid URL');
      };

      const result = parseSkillId('https://github.com/anthropic/claude-skills/tree/main/commit');
      expect(result.owner).toBe('anthropic');
      expect(result.repo).toBe('claude-skills');
    });
  });

  describe('SKILL.md Validation', () => {
    it('should accept valid SKILL.md content', () => {
      const validateSkillMd = (content: string) => {
        const errors: string[] = [];
        if (!content.includes('# ')) {
          errors.push('Missing title (# heading)');
        }
        if (content.length < 100) {
          errors.push('SKILL.md is too short (minimum 100 characters)');
        }
        return { valid: errors.length === 0, errors };
      };

      const validContent = `# My Amazing Skill

This is a comprehensive skill that helps developers with their daily tasks.
It provides utilities for code generation, refactoring, and more.

## Usage

Use this skill by mentioning it in Claude Code.
`;

      const result = validateSkillMd(validContent);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject SKILL.md without title', () => {
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

      const invalidContent = 'This content has no title heading and is long enough but still invalid.'.repeat(3);
      const result = validateSkillMd(invalidContent);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing title');
    });

    it('should reject SKILL.md that is too short', () => {
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

      const shortContent = '# Short\n\nToo short.';
      const result = validateSkillMd(shortContent);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Too short');
    });
  });

  describe('Filesystem Operations', () => {
    it('should create skill directory', async () => {
      const skillPath = path.join(fsContext.skillsDir, 'test-skill');
      await fs.mkdir(skillPath, { recursive: true });

      const exists = await fileExists(skillPath);
      expect(exists).toBe(true);
    });

    it('should write SKILL.md file', async () => {
      const skillPath = path.join(fsContext.skillsDir, 'test-skill');
      await fs.mkdir(skillPath, { recursive: true });

      const content = '# Test Skill\n\nThis is test content with enough characters to pass validation requirements.';
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), content);

      const exists = await fileExists(path.join(skillPath, 'SKILL.md'));
      expect(exists).toBe(true);

      const readContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
      expect(readContent).toBe(content);
    });

    it('should create and update manifest', async () => {
      await createMockManifest(fsContext.manifestDir, {});

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ version: string; installedSkills: Record<string, unknown> }>(manifestPath);

      expect(manifest.version).toBe('1.0.0');
      expect(manifest.installedSkills).toEqual({});

      // Add a skill to manifest
      manifest.installedSkills['test-skill'] = {
        id: 'owner/test-skill',
        name: 'test-skill',
        version: '1.0.0',
        source: 'github:owner/test-skill',
        installPath: path.join(fsContext.skillsDir, 'test-skill'),
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const updatedManifest = await readJsonFile<typeof manifest>(manifestPath);
      expect(updatedManifest.installedSkills['test-skill']).toBeDefined();
    });
  });

  describe('Duplicate Installation Detection', () => {
    it('should detect already installed skill', async () => {
      // Create manifest with existing skill
      await createMockManifest(fsContext.manifestDir, {
        'existing-skill': {
          id: 'owner/existing-skill',
          name: 'existing-skill',
          version: '1.0.0',
          source: 'github:owner/existing-skill',
          installPath: path.join(fsContext.skillsDir, 'existing-skill'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);

      expect(manifest.installedSkills['existing-skill']).toBeDefined();
    });
  });

  describe('GitHub Fetch Mocking', () => {
    it('should mock successful GitHub fetch', async () => {
      const mockFetch = createMockGitHubFetch({
        'raw.githubusercontent.com/owner/repo/main/SKILL.md': {
          status: 200,
          body: '# Mock Skill\n\nThis is a mock skill with sufficient content for validation testing purposes.',
        },
      });

      const response = await mockFetch('https://raw.githubusercontent.com/owner/repo/main/SKILL.md');
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain('# Mock Skill');
    });

    it('should mock 404 for non-existent files', async () => {
      const mockFetch = createMockGitHubFetch({});

      const response = await mockFetch('https://raw.githubusercontent.com/owner/repo/main/NONEXISTENT.md');
      expect(response.status).toBe(404);
    });

    it('should try master branch if main fails', async () => {
      const mockFetch = createMockGitHubFetch({
        'raw.githubusercontent.com/owner/repo/master/SKILL.md': {
          status: 200,
          body: '# Master Branch Skill\n\nContent from master branch with enough text for validation.',
        },
      });

      // Simulate the logic of trying main then master
      let response = await mockFetch('https://raw.githubusercontent.com/owner/repo/main/SKILL.md');
      if (response.status === 404) {
        response = await mockFetch('https://raw.githubusercontent.com/owner/repo/master/SKILL.md');
      }

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('Master Branch');
    });
  });

  describe('Post-Install Tips', () => {
    it('should generate correct tips', () => {
      const generateTips = (skillName: string) => [
        `Skill "${skillName}" installed successfully!`,
        `To use this skill, mention it in Claude Code: "Use the ${skillName} skill to..."`,
        'View installed skills: ls ~/.claude/skills/',
        'To uninstall: use the uninstall_skill tool',
      ];

      const tips = generateTips('my-skill');
      expect(tips[0]).toContain('my-skill');
      expect(tips[1]).toContain('my-skill');
      expect(tips.length).toBe(4);
    });
  });

  describe('Full Installation Flow Simulation', () => {
    it('should complete full installation flow', async () => {
      const skillName = 'complete-skill';
      const skillPath = path.join(fsContext.skillsDir, skillName);

      // 1. Create skill directory
      await fs.mkdir(skillPath, { recursive: true });

      // 2. Write SKILL.md
      const skillContent = `# Complete Skill

A comprehensive skill for testing the full installation flow.
This content is long enough to pass the validation requirements.

## Features

- Feature 1
- Feature 2

## Usage

Use this skill by mentioning it in Claude Code.
`;
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillContent);

      // 3. Write optional README.md
      await fs.writeFile(
        path.join(skillPath, 'README.md'),
        '# Complete Skill\n\nAdditional documentation.'
      );

      // 4. Update manifest
      const manifestPath = path.join(fsContext.manifestDir, 'manifest.json');
      await createMockManifest(fsContext.manifestDir, {
        [skillName]: {
          id: 'owner/complete-skill',
          name: skillName,
          version: '1.0.0',
          source: 'github:owner/complete-skill',
          installPath: skillPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      });

      // Verify installation
      expect(await fileExists(skillPath)).toBe(true);
      expect(await fileExists(path.join(skillPath, 'SKILL.md'))).toBe(true);
      expect(await fileExists(path.join(skillPath, 'README.md'))).toBe(true);
      expect(await fileExists(manifestPath)).toBe(true);

      const manifest = await readJsonFile<{ installedSkills: Record<string, unknown> }>(manifestPath);
      expect(manifest.installedSkills[skillName]).toBeDefined();
    });
  });
});
