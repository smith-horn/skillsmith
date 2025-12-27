/**
 * Core package shim for testing
 * Re-exports only the modules needed by MCP server, avoiding heavy dependencies like ONNX
 */

// Error handling
export {
  ErrorCodes,
  ErrorSuggestions,
  SkillsmithError,
  createErrorResponse,
  withErrorBoundary,
  type ErrorCategory,
  type ErrorCode,
  type ErrorResponse,
} from '../../core/src/errors.js';

// MCP types
export {
  TrustTierDescriptions,
  type TrustTier as MCPTrustTier,
  type SkillCategory,
  type ScoreBreakdown,
  type Skill as MCPSkill,
  type SkillSearchResult,
  type SearchFilters,
  type SearchResponse as MCPSearchResponse,
  type GetSkillResponse,
} from '../../core/src/types.js';
