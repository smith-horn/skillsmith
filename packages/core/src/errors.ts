/**
 * Skillsmith Error Code Taxonomy
 * SMI-583: Structured error handling
 */

// Error code categories
export type ErrorCategory =
  | 'SKILL' // Skill-related errors
  | 'SEARCH' // Search operation errors
  | 'CONFIG' // Configuration errors
  | 'NETWORK' // Network/API errors
  | 'VALIDATION' // Input validation errors
  | 'INTERNAL' // Internal system errors

// Specific error codes
export const ErrorCodes = {
  // Skill errors
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SKILL_INVALID_ID: 'SKILL_INVALID_ID',
  SKILL_INSTALL_FAILED: 'SKILL_INSTALL_FAILED',
  SKILL_PARSE_ERROR: 'SKILL_PARSE_ERROR',

  // Search errors
  SEARCH_QUERY_EMPTY: 'SEARCH_QUERY_EMPTY',
  SEARCH_QUERY_INVALID: 'SEARCH_QUERY_INVALID',
  SEARCH_INDEX_UNAVAILABLE: 'SEARCH_INDEX_UNAVAILABLE',
  SEARCH_TIMEOUT: 'SEARCH_TIMEOUT',

  // Config errors
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_PERMISSION_DENIED: 'CONFIG_PERMISSION_DENIED',

  // Network errors
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  NETWORK_RATE_LIMITED: 'NETWORK_RATE_LIMITED',
  NETWORK_INVALID_RESPONSE: 'NETWORK_INVALID_RESPONSE',

  // Validation errors
  VALIDATION_REQUIRED_FIELD: 'VALIDATION_REQUIRED_FIELD',
  VALIDATION_INVALID_TYPE: 'VALIDATION_INVALID_TYPE',
  VALIDATION_OUT_OF_RANGE: 'VALIDATION_OUT_OF_RANGE',

  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INTERNAL_NOT_IMPLEMENTED: 'INTERNAL_NOT_IMPLEMENTED',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Structured error response format
 */
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
    suggestion?: string
    details?: Record<string, unknown>
  }
}

/**
 * Error suggestions map for actionable feedback
 */
export const ErrorSuggestions: Partial<Record<ErrorCode, string>> = {
  SKILL_NOT_FOUND: 'Try searching with different keywords or check the skill ID spelling',
  SKILL_INVALID_ID: 'Skill IDs should be in format "author/skill-name" or a valid UUID',
  SEARCH_QUERY_EMPTY: 'Provide a search query with at least 2 characters',
  SEARCH_INDEX_UNAVAILABLE: 'The search index is being updated. Please try again in a moment',
  CONFIG_NOT_FOUND: 'Run "skillsmith init" to create the configuration file',
  NETWORK_RATE_LIMITED: 'Wait a few minutes before trying again',
}

/**
 * Custom error class for Skillsmith operations
 */
export class SkillsmithError extends Error {
  public readonly code: ErrorCode
  public readonly suggestion?: string
  public readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      suggestion?: string
      details?: Record<string, unknown>
      cause?: Error
    }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'SkillsmithError'
    this.code = code
    this.suggestion = options?.suggestion ?? ErrorSuggestions[code]
    this.details = options?.details
  }

  /**
   * Convert to structured error response
   */
  toResponse(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        suggestion: this.suggestion,
        details: this.details,
      },
    }
  }

  /**
   * Format for terminal display
   */
  toTerminalString(): string {
    let output = `Error [${this.code}]: ${this.message}`
    if (this.suggestion) {
      output += `\n  Suggestion: ${this.suggestion}`
    }
    return output
  }
}

/**
 * Create an error response from an unknown error
 */
export function createErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof SkillsmithError) {
    return error.toResponse()
  }

  if (error instanceof Error) {
    return {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: error.message,
        suggestion: 'An unexpected error occurred. Please try again or report this issue.',
        details: { stack: error.stack },
      },
    }
  }

  return {
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: String(error),
      suggestion: 'An unexpected error occurred. Please try again.',
    },
  }
}

/**
 * Wrap a handler function with error boundary
 */
export function withErrorBoundary<T extends (...args: unknown[]) => Promise<unknown>>(
  handler: T,
  logError?: (error: unknown) => void
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args)
    } catch (error) {
      logError?.(error)
      throw error instanceof SkillsmithError
        ? error
        : new SkillsmithError(
            ErrorCodes.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            { cause: error instanceof Error ? error : undefined }
          )
    }
  }) as T
}
