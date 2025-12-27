/**
 * Tests for SMI-582: MCP Get Skill Tool
 */

import { describe, it, expect } from 'vitest';
import { executeGetSkill, formatSkillDetails } from '../tools/get-skill.js';
import { SkillsmithError, ErrorCodes } from '@skillsmith/core';

describe('Get Skill Tool', () => {
  describe('executeGetSkill', () => {
    it('should return skill details for valid ID', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });

      expect(result.skill).toBeDefined();
      expect(result.skill.id).toBe('anthropic/commit');
      expect(result.skill.name).toBe('commit');
      expect(result.skill.author).toBe('anthropic');
      expect(result.skill.description).toBeDefined();
      expect(result.skill.trustTier).toBe('verified');
      expect(result.skill.score).toBeGreaterThan(0);
      expect(result.installCommand).toBeDefined();
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('should include score breakdown', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });

      expect(result.skill.scoreBreakdown).toBeDefined();
      expect(result.skill.scoreBreakdown?.quality).toBeDefined();
      expect(result.skill.scoreBreakdown?.popularity).toBeDefined();
      expect(result.skill.scoreBreakdown?.maintenance).toBeDefined();
      expect(result.skill.scoreBreakdown?.security).toBeDefined();
      expect(result.skill.scoreBreakdown?.documentation).toBeDefined();
    });

    it('should include repository URL', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });

      expect(result.skill.repository).toBeDefined();
      expect(result.skill.repository).toContain('github.com');
    });

    it('should throw SKILL_NOT_FOUND for invalid skill', async () => {
      try {
        await executeGetSkill({ id: 'nonexistent/skill' });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError);
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND);
      }
    });

    it('should throw SKILL_INVALID_ID for malformed ID', async () => {
      try {
        await executeGetSkill({ id: 'not-valid-format' });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError);
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_INVALID_ID);
      }
    });

    it('should throw VALIDATION_REQUIRED_FIELD for empty ID', async () => {
      try {
        await executeGetSkill({ id: '' });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError);
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_REQUIRED_FIELD);
      }
    });

    it('should handle case-insensitive IDs', async () => {
      const result = await executeGetSkill({ id: 'ANTHROPIC/COMMIT' });

      expect(result.skill.id).toBe('anthropic/commit');
    });
  });

  describe('formatSkillDetails', () => {
    it('should format skill details for terminal display', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });
      const formatted = formatSkillDetails(result);

      expect(formatted).toContain('commit');
      expect(formatted).toContain('Author:');
      expect(formatted).toContain('Version:');
      expect(formatted).toContain('Trust Tier:');
      expect(formatted).toContain('Overall Score:');
      expect(formatted).toContain('Installation');
    });

    it('should display score breakdown as bars', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });
      const formatted = formatSkillDetails(result);

      expect(formatted).toContain('Quality:');
      expect(formatted).toContain('Popularity:');
      expect(formatted).toContain('[');
      expect(formatted).toContain(']');
    });

    it('should include trust tier explanation', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });
      const formatted = formatSkillDetails(result);

      expect(formatted).toContain('VERIFIED');
      expect(formatted).toContain('Manually reviewed');
    });

    it('should show installation command', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' });
      const formatted = formatSkillDetails(result);

      expect(formatted).toContain('claude skill add');
    });
  });
});
