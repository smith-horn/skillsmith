/**
 * Skillsmith Error Classes - SMI-881
 *
 * Custom error classes with proper cause chaining for better error propagation.
 * Ensures stack traces and context are preserved through error handling layers.
 */

/**
 * Base error class for all Skillsmith errors.
 * Preserves cause chain and provides structured error information.
 */
export class SkillsmithError extends Error {
  /** Error code for programmatic handling */
  readonly code: string

  /** Additional context about the error */
  readonly context?: Record<string, unknown>

  constructor(
    message: string,
    options?: {
      code?: string
      cause?: unknown
      context?: Record<string, unknown>
    }
  ) {
    super(message, { cause: options?.cause })
    this.name = 'SkillsmithError'
    this.code = options?.code ?? 'SKILLSMITH_ERROR'
    this.context = options?.context

    // Capture stack trace excluding constructor
    Error.captureStackTrace?.(this, this.constructor)
  }

  /**
   * Get the full error chain as an array
   */
  getErrorChain(): Error[] {
    const chain: Error[] = [this]
    let current: unknown = this.cause

    while (current instanceof Error) {
      chain.push(current)
      current = current.cause
    }

    return chain
  }

  /**
   * Format error with full context for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
      stack: this.stack,
    }
  }
}

/**
 * Network-related errors (fetch failures, timeouts, etc.)
 */
export class NetworkError extends SkillsmithError {
  constructor(
    message: string,
    options?: {
      cause?: unknown
      url?: string
      statusCode?: number
      context?: Record<string, unknown>
    }
  ) {
    super(message, {
      code: 'NETWORK_ERROR',
      cause: options?.cause,
      context: {
        ...options?.context,
        url: options?.url,
        statusCode: options?.statusCode,
      },
    })
    this.name = 'NetworkError'
  }
}

/**
 * API-specific errors (rate limits, auth failures, etc.)
 *
 * Note: Rate limit detection includes both 429 (standard) and 403 (GitHub).
 * GitHub returns 403 Forbidden for rate limit exceeded instead of 429.
 * See: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export class ApiError extends SkillsmithError {
  /** HTTP status code if applicable */
  readonly statusCode?: number

  constructor(
    message: string,
    options?: {
      cause?: unknown
      statusCode?: number
      url?: string
      context?: Record<string, unknown>
    }
  ) {
    super(message, {
      // Check both 429 (standard) and 403 (GitHub uses 403 for rate limits)
      code:
        options?.statusCode === 429 || options?.statusCode === 403
          ? 'RATE_LIMIT_ERROR'
          : 'API_ERROR',
      cause: options?.cause,
      context: {
        ...options?.context,
        url: options?.url,
        statusCode: options?.statusCode,
      },
    })
    this.name = 'ApiError'
    this.statusCode = options?.statusCode
  }

  /**
   * Check if this is a rate limit error
   */
  isRateLimitError(): boolean {
    return this.statusCode === 429 || this.statusCode === 403
  }

  /**
   * Check if this is a not found error
   */
  isNotFoundError(): boolean {
    return this.statusCode === 404
  }

  /**
   * Check if this is a server error (5xx)
   */
  isServerError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 500
  }
}

/**
 * Validation errors (invalid input, schema violations)
 */
export class ValidationError extends SkillsmithError {
  /** Field that failed validation */
  readonly field?: string

  constructor(
    message: string,
    options?: {
      cause?: unknown
      field?: string
      context?: Record<string, unknown>
    }
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      cause: options?.cause,
      context: {
        ...options?.context,
        field: options?.field,
      },
    })
    this.name = 'ValidationError'
    this.field = options?.field
  }
}

/**
 * Skill-related errors (not found, invalid structure, etc.)
 */
export class SkillError extends SkillsmithError {
  /** Skill ID if applicable */
  readonly skillId?: string

  constructor(
    message: string,
    options?: {
      cause?: unknown
      skillId?: string
      context?: Record<string, unknown>
    }
  ) {
    super(message, {
      code: 'SKILL_ERROR',
      cause: options?.cause,
      context: {
        ...options?.context,
        skillId: options?.skillId,
      },
    })
    this.name = 'SkillError'
    this.skillId = options?.skillId
  }
}

/**
 * Configuration errors
 */
export class ConfigurationError extends SkillsmithError {
  constructor(
    message: string,
    options?: {
      cause?: unknown
      context?: Record<string, unknown>
    }
  ) {
    super(message, {
      code: 'CONFIGURATION_ERROR',
      cause: options?.cause,
      context: options?.context,
    })
    this.name = 'ConfigurationError'
  }
}

/**
 * Wrap an unknown error in a SkillsmithError if not already one
 */
export function wrapError(
  error: unknown,
  message: string,
  options?: {
    code?: string
    context?: Record<string, unknown>
  }
): SkillsmithError {
  if (error instanceof SkillsmithError) {
    return error
  }

  return new SkillsmithError(message, {
    code: options?.code,
    cause: error,
    context: options?.context,
  })
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}

/**
 * Check if error is a specific type
 */
export function isSkillsmithError(error: unknown): error is SkillsmithError {
  return error instanceof SkillsmithError
}
