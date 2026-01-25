/**
 * Validation Error Class
 *
 * Thrown when input fails security validation checks.
 */

/**
 * Validation error thrown when input fails security checks
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}
