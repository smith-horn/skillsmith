/**
 * SMI-578: SkillRepository Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db/schema.js';
import { SkillRepository } from '../src/repositories/SkillRepository.js';
import type { SkillCreateInput } from '../src/types/skill.js';

describe('SkillRepository', () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SkillRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    repo = new SkillRepository(db);
  });

  afterEach(() => {
    if (db) closeDatabase(db);
  });

  describe('create', () => {
    it('should create a skill with generated ID', () => {
      const skill = repo.create({
        name: 'Test Skill',
        description: 'A test skill'
      });

      expect(skill.id).toBeDefined();
      expect(skill.name).toBe('Test Skill');
      expect(skill.description).toBe('A test skill');
      expect(skill.trustTier).toBe('unknown');
      expect(skill.createdAt).toBeDefined();
    });

    it('should create a skill with custom ID', () => {
      const skill = repo.create({
        id: 'custom-id',
        name: 'Custom ID Skill'
      });

      expect(skill.id).toBe('custom-id');
    });

    it('should handle all optional fields', () => {
      const skill = repo.create({
        name: 'Full Skill',
        description: 'Description',
        author: 'Author Name',
        repoUrl: 'https://github.com/test/skill',
        qualityScore: 0.85,
        trustTier: 'verified',
        tags: ['tag1', 'tag2']
      });

      expect(skill.author).toBe('Author Name');
      expect(skill.repoUrl).toBe('https://github.com/test/skill');
      expect(skill.qualityScore).toBe(0.85);
      expect(skill.trustTier).toBe('verified');
      expect(skill.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('createBatch', () => {
    it('should insert multiple skills efficiently', () => {
      const inputs: SkillCreateInput[] = Array.from({ length: 100 }, (_, i) => ({
        name: `Skill ${i}`,
        description: `Description ${i}`,
        repoUrl: `https://github.com/test/skill-${i}`
      }));

      const skills = repo.createBatch(inputs);

      expect(skills.length).toBe(100);
      expect(repo.count()).toBe(100);
    });

    it('should skip duplicates on repo_url', () => {
      const inputs: SkillCreateInput[] = [
        { name: 'Skill 1', repoUrl: 'https://github.com/test/skill' },
        { name: 'Skill 2', repoUrl: 'https://github.com/test/skill' } // Duplicate
      ];

      const skills = repo.createBatch(inputs);

      expect(skills.length).toBe(1);
      expect(repo.count()).toBe(1);
    });

    it('should handle 1000+ skills', () => {
      const inputs: SkillCreateInput[] = Array.from({ length: 1000 }, (_, i) => ({
        name: `Skill ${i}`,
        repoUrl: `https://github.com/test/skill-${i}`
      }));

      const start = Date.now();
      const skills = repo.createBatch(inputs);
      const duration = Date.now() - start;

      expect(skills.length).toBe(1000);
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });

  describe('findById', () => {
    it('should find existing skill', () => {
      const created = repo.create({ name: 'Find Me' });
      const found = repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.name).toBe('Find Me');
    });

    it('should return null for non-existent skill', () => {
      const found = repo.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findByRepoUrl', () => {
    it('should find skill by repo URL', () => {
      const url = 'https://github.com/test/unique-repo';
      repo.create({ name: 'Repo Skill', repoUrl: url });

      const found = repo.findByRepoUrl(url);

      expect(found).not.toBeNull();
      expect(found?.repoUrl).toBe(url);
    });

    it('should return null for non-existent URL', () => {
      const found = repo.findByRepoUrl('https://github.com/non/existent');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return paginated results', () => {
      for (let i = 0; i < 25; i++) {
        repo.create({ name: `Skill ${i}` });
      }

      const page1 = repo.findAll(10, 0);
      expect(page1.items.length).toBe(10);
      expect(page1.total).toBe(25);
      expect(page1.hasMore).toBe(true);

      const page2 = repo.findAll(10, 10);
      expect(page2.items.length).toBe(10);
      expect(page2.hasMore).toBe(true);

      const page3 = repo.findAll(10, 20);
      expect(page3.items.length).toBe(5);
      expect(page3.hasMore).toBe(false);
    });

    it('should use default pagination values', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({ name: `Skill ${i}` });
      }

      const result = repo.findAll();
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });
  });

  describe('update', () => {
    it('should update skill fields', () => {
      const skill = repo.create({ name: 'Original' });

      const updated = repo.update(skill.id, {
        name: 'Updated',
        description: 'New description'
      });

      expect(updated?.name).toBe('Updated');
      expect(updated?.description).toBe('New description');
    });

    it('should only update provided fields', () => {
      const skill = repo.create({
        name: 'Original',
        description: 'Original description',
        author: 'Original author'
      });

      const updated = repo.update(skill.id, { name: 'Updated' });

      expect(updated?.name).toBe('Updated');
      expect(updated?.description).toBe('Original description');
      expect(updated?.author).toBe('Original author');
    });

    it('should return null for non-existent skill', () => {
      const result = repo.update('non-existent', { name: 'Test' });
      expect(result).toBeNull();
    });

    it('should update tags correctly', () => {
      const skill = repo.create({ name: 'Tagged', tags: ['old'] });

      const updated = repo.update(skill.id, { tags: ['new1', 'new2'] });

      expect(updated?.tags).toEqual(['new1', 'new2']);
    });
  });

  describe('delete', () => {
    it('should delete existing skill', () => {
      const skill = repo.create({ name: 'Delete Me' });

      const result = repo.delete(skill.id);

      expect(result).toBe(true);
      expect(repo.findById(skill.id)).toBeNull();
    });

    it('should return false for non-existent skill', () => {
      const result = repo.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('deleteAll', () => {
    it('should delete all skills', () => {
      for (let i = 0; i < 10; i++) {
        repo.create({ name: `Skill ${i}` });
      }

      const count = repo.deleteAll();

      expect(count).toBe(10);
      expect(repo.count()).toBe(0);
    });
  });

  describe('transaction', () => {
    it('should commit successful transaction', () => {
      repo.transaction(() => {
        repo.create({ name: 'Transaction Skill 1' });
        repo.create({ name: 'Transaction Skill 2' });
      });

      expect(repo.count()).toBe(2);
    });

    it('should rollback failed transaction', () => {
      expect(() => {
        repo.transaction(() => {
          repo.create({ name: 'Before Error' });
          throw new Error('Rollback!');
        });
      }).toThrow('Rollback!');

      expect(repo.count()).toBe(0);
    });
  });

  describe('exists', () => {
    it('should return true for existing skill', () => {
      const skill = repo.create({ name: 'Exists' });
      expect(repo.exists(skill.id)).toBe(true);
    });

    it('should return false for non-existent skill', () => {
      expect(repo.exists('non-existent')).toBe(false);
    });
  });

  describe('upsert', () => {
    it('should insert new skill', () => {
      const skill = repo.upsert({
        name: 'New Skill',
        repoUrl: 'https://github.com/test/new'
      });

      expect(skill.name).toBe('New Skill');
      expect(repo.count()).toBe(1);
    });

    it('should update existing skill by repo URL', () => {
      const url = 'https://github.com/test/upsert';
      repo.create({ name: 'Original', repoUrl: url });

      const skill = repo.upsert({
        name: 'Updated',
        repoUrl: url
      });

      expect(skill.name).toBe('Updated');
      expect(repo.count()).toBe(1);
    });
  });
});
