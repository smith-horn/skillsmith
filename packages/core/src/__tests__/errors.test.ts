/**
 * Tests for SMI-583: Structured Error Handling
 */

import { describe, it, expect } from 'vitest';
import {
  SkillsmithError,
  ErrorCodes,
  createErrorResponse,
  withErrorBoundary,
  ErrorSuggestions,
} from '../errors.js';

describe('Error Handling', () => {
  describe('SkillsmithError', () => {
    it('should create error with code and message', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found'
      );

      expect(error.code).toBe('SKILL_NOT_FOUND');
      expect(error.message).toBe('Skill xyz not found');
      expect(error.name).toBe('SkillsmithError');
    });

    it('should use default suggestion if not provided', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found'
      );

      expect(error.suggestion).toBe(ErrorSuggestions.SKILL_NOT_FOUND);
    });

    it('should use custom suggestion when provided', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found',
        { suggestion: 'Custom suggestion' }
      );

      expect(error.suggestion).toBe('Custom suggestion');
    });

    it('should include details', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found',
        { details: { id: 'xyz' } }
      );

      expect(error.details).toEqual({ id: 'xyz' });
    });

    it('should convert to response format', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found',
        { details: { id: 'xyz' } }
      );

      const response = error.toResponse();

      expect(response.error.code).toBe('SKILL_NOT_FOUND');
      expect(response.error.message).toBe('Skill xyz not found');
      expect(response.error.suggestion).toBeDefined();
      expect(response.error.details).toEqual({ id: 'xyz' });
    });

    it('should format for terminal display', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Skill xyz not found'
      );

      const terminal = error.toTerminalString();

      expect(terminal).toContain('SKILL_NOT_FOUND');
      expect(terminal).toContain('Skill xyz not found');
      expect(terminal).toContain('Suggestion:');
    });
  });

  describe('createErrorResponse', () => {
    it('should handle SkillsmithError', () => {
      const error = new SkillsmithError(
        ErrorCodes.SKILL_NOT_FOUND,
        'Not found'
      );

      const response = createErrorResponse(error);

      expect(response.error.code).toBe('SKILL_NOT_FOUND');
    });

    it('should handle generic Error', () => {
      const error = new Error('Something went wrong');

      const response = createErrorResponse(error);

      expect(response.error.code).toBe('INTERNAL_ERROR');
      expect(response.error.message).toBe('Something went wrong');
    });

    it('should handle non-Error values', () => {
      const response = createErrorResponse('string error');

      expect(response.error.code).toBe('INTERNAL_ERROR');
      expect(response.error.message).toBe('string error');
    });
  });

  describe('withErrorBoundary', () => {
    it('should pass through successful results', async () => {
      const handler = async (x: unknown) => (x as number) * 2;
      const wrapped = withErrorBoundary(handler);

      const result = await wrapped(5);

      expect(result).toBe(10);
    });

    it('should convert generic errors to SkillsmithError', async () => {
      const handler = async () => {
        throw new Error('Test error');
      };
      const wrapped = withErrorBoundary(handler);

      await expect(wrapped()).rejects.toThrow(SkillsmithError);
    });

    it('should pass through SkillsmithError unchanged', async () => {
      const handler = async () => {
        throw new SkillsmithError(
          ErrorCodes.SKILL_NOT_FOUND,
          'Not found'
        );
      };
      const wrapped = withErrorBoundary(handler);

      try {
        await wrapped();
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError);
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND);
      }
    });

    it('should call logError callback', async () => {
      let loggedError: unknown;
      const handler = async () => {
        throw new Error('Test error');
      };
      const wrapped = withErrorBoundary(handler, (e) => {
        loggedError = e;
      });

      await expect(wrapped()).rejects.toThrow();
      expect(loggedError).toBeInstanceOf(Error);
    });
  });

  describe('ErrorCodes', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCodes.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
      expect(ErrorCodes.SKILL_INVALID_ID).toBe('SKILL_INVALID_ID');
      expect(ErrorCodes.SEARCH_QUERY_EMPTY).toBe('SEARCH_QUERY_EMPTY');
      expect(ErrorCodes.VALIDATION_REQUIRED_FIELD).toBe('VALIDATION_REQUIRED_FIELD');
      expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });
  });
});
